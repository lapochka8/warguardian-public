import {
  rustMapScale,
  rustHostResources,
  type RustHostResource,
} from '../../vendor/games/rust-host';
import { rustPermissionLines } from '../../vendor/games/rust-permissions';
import type { RustServerConfig } from '../config';
import type { RustHostController } from '../games/rust-host';
import { AgentError } from '../errors';
import { ReplyMissing } from '../games/battleye-session';
import { checkedPassword, rconHost, readText } from '../games/game-config';
import {
  rustBanId,
  rustBanListed,
  rustFrameworks,
  rustKick,
  rustPlayerState,
  rustReadCommands,
  rustSaveConfig,
  rustSay,
  rustSettingConvars,
  rustToolLines,
  rustUnban,
  type RustSettingKey,
} from '../games/rust-commands';
import {
  RustWebRconSession,
  type RustEndpoint,
  type RustPushed,
  type RustWebRconSessionOptions,
} from '../games/rust-webrcon';
import {
  nativeFeedLineMaxChars,
  nativePaths,
  parseNativeOperation,
  rustOperation,
  type AgentCommand,
  type NativeEventFeed,
  type NativeIdentityFeed,
  type NativeOperationResult,
  type RustOperation,
} from '../protocol';
import { EventBuffer, cursorOf } from './events';
import {
  errorResponse,
  jsonResponse,
  replyMissing,
  unsupportedRoute,
  type CommandResponse,
  type ProfileHandler,
} from './types';

/** Where the host settings and state of one server live. */
export type RustHostLocations = {
  settingsFile: string;
  stateDirectory: string;
};

export type RustProfileOptions = {
  /** Game host management. Without it, host routes are unsupported. */
  host?: RustHostLocations;
  session?: Omit<
    RustWebRconSessionOptions,
    'endpoint' | 'onMessage' | 'onOpen'
  >;
  reconnectMs?: number;
  /** The wait before the player list is read again after a kick of everyone. */
  settleMs?: number;
};

const rustHostPrefix = '/native/v1/host/';
const rustHostCommandPath = '/native/v1/host/command';

function invalidOperation(): AgentError {
  return new AgentError(
    400,
    'invalid-operation',
    'The operation is not valid for this server.',
  );
}

/** The settings that make the server print player reports and AntiHack notices. */
const eventSettings = [
  'server.printreportstoconsole true',
  'antihack.reporting true',
];

/** `name "value"` or `name value` from a Rust `server.cfg`. */
export function rustConfigValue(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_.]+)\s+(?:"([^"]*)"|(\S+))\s*$/.exec(line);
    if (match && match[1]!.toLowerCase() === name)
      return match[2] ?? match[3] ?? null;
  }
  return null;
}

/**
 * A pushed message as one feed line: JSON with the channel, the severity,
 * the identifier and the text. The text is cut so the line fits the feed.
 */
export function rustFeedLine(message: RustPushed): string {
  let text = message.text;
  for (;;) {
    const line = JSON.stringify({
      c: message.channel,
      s: message.severity,
      i: message.identifier,
      m: text,
    });
    if (line.length <= nativeFeedLineMaxChars) return line;
    text = text.slice(0, Math.floor(text.length * 0.8));
  }
}

/**
 * Rust over one local WebRCON connection. The agent builds every console
 * line from a typed operation and never takes a raw command. A kick checks
 * the player list in the same connection first, because `kick` also matches
 * names.
 */
export function createRustProfile(
  server: RustServerConfig,
  options: RustProfileOptions = {},
): ProfileHandler {
  const events = new EventBuffer<{ at: number; text: string }>({
    maxItems: 2_000,
    maxBytes: 2 * 1024 * 1024,
  });
  let password = '';
  let framework:
    | {
        at: number;
        found: (typeof rustFrameworks)[number] | null;
        version: string;
      }
    | undefined;

  async function endpoint(): Promise<RustEndpoint> {
    let configured: string | null = null;
    let port: number | undefined = server.rconPort;
    if (server.serverConfig && (!server.rconPassword || !port)) {
      const text = await readText(server.serverConfig);
      configured = rustConfigValue(text, 'rcon.password');
      const listed = Number(rustConfigValue(text, 'rcon.port'));
      if (
        !port &&
        Number.isSafeInteger(listed) &&
        listed > 0 &&
        listed < 65_536
      )
        port = listed;
    }
    if (!port)
      throw new AgentError(
        503,
        'not-configured',
        'Set rconPort for this server.',
      );
    password = checkedPassword(server.rconPassword ?? configured ?? undefined);
    return { host: rconHost(server.rconHost, undefined), port, password };
  }

  const session = new RustWebRconSession({
    ...options.session,
    endpoint,
    onMessage: (message) =>
      events.push({ at: message.at, text: rustFeedLine(message) }),
    onOpen: (opened) => {
      for (const line of eventSettings)
        void opened.command(line).catch(() => undefined);
    },
  });
  let reconnect: NodeJS.Timeout | undefined;
  let host: Promise<RustHostController> | null = null;

  /** The host controller, created on first use from the settings file. */
  function hostController(): Promise<RustHostController> {
    const locations = options.host;
    if (!locations)
      throw new AgentError(503, 'not-configured', 'Host settings missing.');
    host ??= (async () => {
      const { createRustHostController, readRustHostSettings } =
        await import('../games/rust-host');
      const settings = await readRustHostSettings(locations.settingsFile);
      if (!settings)
        throw new AgentError(503, 'not-configured', 'Host settings missing.');
      return createRustHostController({
        serverId: server.serverId,
        settings,
        settingsFile: locations.settingsFile,
        stateDirectory: locations.stateDirectory,
        // `quit` saves the world and ends the server.
        quit: async () => {
          await session.command('quit').catch(() => undefined);
        },
        externalRunning: () => session.connected,
        // An updated plugin is reloaded like the `reloadPlugin` operation.
        reloadPlugin: async (name) => {
          if (!session.connected) return false;
          return session.exclusive(async () => {
            const current = await foundFramework();
            if (!current.found) return false;
            const reply = await send(
              rustToolLines.pluginReload(current.found.id, name),
            );
            return reply.includes(name) && !/\b(?:not|error|fail)/i.test(reply);
          });
        },
      });
    })();
    host.catch(() => {
      host = null;
    });
    return host;
  }

  const read = async (line: string): Promise<NativeOperationResult> => ({
    outcome: 'read',
    reply: await session.command(line),
    observedAt: Date.now(),
  });

  /** Send a change. A missing reply is reported, never sent again. */
  async function send(line: string): Promise<string> {
    try {
      return await session.command(line);
    } catch (error) {
      if (error instanceof ReplyMissing) throw replyMissing();
      throw error;
    }
  }

  async function foundFramework() {
    const now = Date.now();
    if (framework && now - framework.at < 600_000) return framework;
    for (const candidate of rustFrameworks) {
      const reply = await session.probe(candidate.version);
      const version = reply
        ? (/\b(\d+\.\d+(?:\.\d+){0,2})\b/.exec(reply)?.[1] ?? null)
        : null;
      if (version) return (framework = { at: now, found: candidate, version });
    }
    return (framework = { at: now, found: null, version: '' });
  }

  function run(op: RustOperation): Promise<NativeOperationResult> {
    switch (op.op) {
      case 'players':
        return read(rustReadCommands.players);
      case 'bans':
        return read(rustReadCommands.bans);
      case 'status':
        return read(rustReadCommands.status);
      case 'info':
        return read(rustToolLines.performance);
      case 'positions':
        return session.exclusive(async () => ({
          outcome: 'read' as const,
          reply: JSON.stringify({
            list: await session.command(rustToolLines.positions),
            size: await session.command(rustToolLines.worldSize),
          }),
          observedAt: Date.now(),
        }));
      case 'lookup':
        return read(rustToolLines.lookup(op.kind, op.steamId));
      case 'settings':
        return session.exclusive(async () => {
          const replies: Record<string, string> = {};
          for (const key of Object.keys(rustSettingConvars) as RustSettingKey[])
            replies[key] = await session.command(rustSettingConvars[key]);
          return {
            outcome: 'read' as const,
            reply: JSON.stringify(replies),
            observedAt: Date.now(),
          };
        });
      case 'plugins':
        return session.exclusive(async () => {
          const current = await foundFramework();
          return {
            outcome: 'read' as const,
            reply: JSON.stringify({
              framework: current.found?.id ?? null,
              version: current.version,
              plugins: current.found
                ? await session.command(current.found.plugins)
                : '',
            }),
            observedAt: Date.now(),
          };
        });
      case 'kickIfSteamId': {
        const line = rustKick(op.steamId, op.reason);
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          const state = rustPlayerState(
            await session.command(rustReadCommands.players),
            op.steamId,
          );
          if (!state?.online || state.shadowed)
            return { outcome: 'target-changed' };
          const reply = await send(line);
          return {
            outcome: 'sent',
            reply: JSON.stringify({ reply, name: state.name }),
          };
        });
      }
      case 'broadcast': {
        const line = rustSay(op.message);
        return session.exclusive(async () => ({
          outcome: 'sent' as const,
          reply: await send(line),
        }));
      }
      case 'addBan': {
        const line = rustBanId(op.steamId, op.minutes, op.reason);
        return session.exclusive(async () => {
          const reply = await send(line);
          // Rust keeps a ban in memory until the config is written.
          await session.command(rustSaveConfig).catch(() => undefined);
          return { outcome: 'sent' as const, reply };
        });
      }
      case 'removeBanForSteamId': {
        const line = rustUnban(op.steamId);
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          if (
            !rustBanListed(
              await session.command(rustReadCommands.bans),
              op.steamId,
            )
          )
            return { outcome: 'not-found' };
          const reply = await send(line);
          await session.command(rustSaveConfig).catch(() => undefined);
          return { outcome: 'sent', reply };
        });
      }
      case 'save':
        return session.exclusive(async () => ({
          outcome: 'sent' as const,
          reply: await send(rustToolLines.save),
        }));
      case 'restart': {
        const line = rustToolLines.restart(op.seconds, op.reason);
        return session.exclusive(async () => ({
          outcome: 'sent' as const,
          reply: await send(line),
        }));
      }
      case 'restartCancel':
        return session.exclusive(async () => ({
          outcome: 'sent' as const,
          reply: await send(rustToolLines.restartCancel),
        }));
      case 'kickAll': {
        const line = rustToolLines.kickAll(op.reason);
        return session.exclusive(async () => {
          const reply = await send(line);
          await new Promise((resolve) =>
            setTimeout(resolve, options.settleMs ?? 1_500),
          );
          const left = rustPlayerState(
            await session.command(rustReadCommands.players).catch(() => ''),
            '',
          );
          return {
            outcome: 'sent' as const,
            reply: JSON.stringify({ reply, players: left?.count ?? null }),
          };
        });
      }
      case 'mute':
      case 'unmute': {
        const line =
          op.op === 'mute'
            ? rustToolLines.mute(op.steamId)
            : rustToolLines.unmute(op.steamId);
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          const reply = await send(line);
          if (reply === 'Player not found')
            return { outcome: 'target-changed' };
          return { outcome: 'sent', reply };
        });
      }
      case 'setSettings': {
        const lines = (Object.keys(rustSettingConvars) as RustSettingKey[])
          .filter((key) => op.values[key] !== undefined)
          .map((key) => ({
            key,
            line: rustToolLines.setting(key, op.values[key]!),
          }));
        if (!lines.length) throw invalidOperation();
        return session.exclusive(async () => {
          const replies: Record<string, string> = {};
          for (const { key, line } of lines) replies[key] = await send(line);
          return {
            outcome: 'sent' as const,
            reply: JSON.stringify({
              replies,
              saved: await send(rustSaveConfig),
            }),
          };
        });
      }
      case 'groups':
      case 'group':
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          const current = await foundFramework();
          if (!current.found) return { outcome: 'unsupported' };
          return read(
            op.op === 'groups'
              ? rustPermissionLines.groups(current.found.id)
              : rustPermissionLines.group(current.found.id, op.group),
          );
        });
      case 'grantGroup':
      case 'revokeGroup':
      case 'groupPlayer':
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          const current = await foundFramework();
          if (!current.found) return { outcome: 'unsupported' };
          const id = current.found.id;
          return {
            outcome: 'sent',
            reply: await send(
              op.op === 'grantGroup'
                ? rustPermissionLines.grant(id, op.group, op.permission)
                : op.op === 'revokeGroup'
                  ? rustPermissionLines.revoke(id, op.group, op.permission)
                  : op.change === 'add'
                    ? rustPermissionLines.addPlayer(id, op.steamId, op.group)
                    : rustPermissionLines.removePlayer(
                        id,
                        op.steamId,
                        op.group,
                      ),
            ),
          };
        });
      case 'renderMap':
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          const size = Number(
            /^server\.worldsize: "(\d+)"$/.exec(
              await session.command(rustToolLines.worldSize),
            )?.[1],
          );
          if (!Number.isSafeInteger(size) || size < 100)
            return { outcome: 'unsupported' };
          return {
            outcome: 'sent',
            reply: await send(rustToolLines.renderMap(rustMapScale(size))),
          };
        });
      case 'admin': {
        const line =
          op.change === 'add'
            ? rustToolLines.admin(op.role, op.steamId)
            : rustToolLines.removeAdmin(op.role, op.steamId);
        return session.exclusive(async () => {
          const reply = await send(line);
          // Rust keeps the admin list in memory until the config is written.
          const saved = await session.command(rustSaveConfig).catch(() => '');
          return {
            outcome: 'sent' as const,
            reply: saved === 'Config Saved' ? reply : `${reply}\nnot saved`,
          };
        });
      }
      case 'give': {
        const line = rustToolLines.give(op.item, op.steamId, op.amount);
        return session.exclusive(async () => ({
          outcome: 'sent' as const,
          reply: await send(line),
        }));
      }
      case 'killPlayer': {
        const line = rustToolLines.kill(op.steamId);
        return session.exclusive(async () => ({
          outcome: 'sent' as const,
          reply: await send(line),
        }));
      }
      case 'teleport': {
        const line = rustToolLines.teleport(op.steamId, op.toSteamId);
        return session.exclusive(async () => ({
          outcome: 'sent' as const,
          reply: await send(line),
        }));
      }
      case 'skipQueue': {
        const line = rustToolLines.skipQueue(op.steamId, op.change === 'add');
        return session.exclusive(async () => ({
          outcome: 'sent' as const,
          reply: await send(line),
        }));
      }
      case 'reloadPlugin':
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          const current = await foundFramework();
          if (!current.found) return { outcome: 'unsupported' };
          return {
            outcome: 'sent',
            reply: await send(
              rustToolLines.pluginReload(current.found.id, op.plugin),
            ),
          };
        });
    }
  }

  return {
    profile: 'rust',
    secrets: () => (password ? [password] : []),
    start() {
      const attempt = () => {
        if (!session.connected) void session.connect().catch(() => undefined);
      };
      attempt();
      // The host controller watches for a crash from the start.
      if (options.host)
        void Promise.resolve()
          .then(hostController)
          .catch(() => undefined);
      reconnect = setInterval(attempt, options.reconnectMs ?? 15_000);
      reconnect.unref();
    },
    async close() {
      clearInterval(reconnect);
      session.close();
      if (host)
        await host.then(
          (controller) => controller.close(),
          () => undefined,
        );
    },
    async handle(command: AgentCommand): Promise<CommandResponse> {
      const path = command.path.split('?')[0];
      try {
        if (command.method === 'POST' && command.path === nativePaths.op) {
          const op = parseNativeOperation(rustOperation, command.body);
          if (!op) throw invalidOperation();
          return jsonResponse(200, await run(op));
        }
        if (command.method === 'GET' && path === nativePaths.events) {
          const page = events.read(cursorOf(command.path));
          return jsonResponse(200, {
            cursor: page.cursor,
            lines: page.items,
            dropped: page.dropped,
          } satisfies NativeEventFeed);
        }
        if (path?.startsWith(rustHostPrefix)) {
          const resource = path.slice(rustHostPrefix.length);
          if (
            command.method === 'POST' &&
            command.path === rustHostCommandPath
          ) {
            let body: unknown;
            try {
              body = JSON.parse(command.body ?? '');
            } catch {
              throw invalidOperation();
            }
            return jsonResponse(
              200,
              await (await hostController()).execute(body),
            );
          }
          if (
            command.method === 'GET' &&
            (rustHostResources as readonly string[]).includes(resource)
          )
            return jsonResponse(
              200,
              await (
                await hostController()
              ).read(
                resource as RustHostResource,
                new URLSearchParams(command.path.split('?')[1] ?? ''),
              ),
            );
          return unsupportedRoute();
        }
        if (command.method === 'GET' && path === nativePaths.identity) {
          // The player list already carries Steam IDs.
          return jsonResponse(200, {
            cursor: events.stream,
            entries: [],
            dropped: 0,
          } satisfies NativeIdentityFeed);
        }
        return unsupportedRoute();
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
