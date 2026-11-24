import { posix, win32 } from 'node:path';
import type { BattlEyeServerConfig } from '../config';
import type { BohemiaHostController } from '../games/bohemia-host';
import {
  bohemiaHostPaths,
  bohemiaHostResources,
  type BohemiaHostResource,
} from '../../vendor/games/bohemia-host';
import { AgentError } from '../errors';
import {
  battleyeAddBan,
  battleyeKick,
  battleyeReadCommands,
  battleyeRemoveBan,
  battleyeSay,
  parseBattlEyeGuidBans,
  parseBattlEyePlayers,
} from '../games/battleye-commands';
import {
  BattlEyeSession,
  LoginChanged,
  ReplyMissing,
  gameUnavailable,
  type BattlEyeSessionOptions,
} from '../games/battleye-session';
import {
  battleyeConfigFile,
  checkedPassword,
  parseBattlEyeConfig,
  rconHost,
  readText,
} from '../games/game-config';
import { feedText } from '../games/text';
import {
  battleyeOperation,
  nativeFeedLineMaxChars,
  nativePaths,
  parseNativeOperation,
  type AgentCommand,
  type BattlEyeOperation,
  type NativeEventFeed,
  type NativeIdentityFeed,
  type NativeOperationResult,
} from '../protocol';
import { EventBuffer, cursorOf } from './events';
import { connectionReader, followNewestLog } from './log-tail';
import {
  errorResponse,
  jsonResponse,
  replyMissing,
  unsupportedRoute,
  type CommandResponse,
  type ProfileHandler,
} from './types';

/** Where the host settings and state of one server live. */
export type BohemiaHostLocations = {
  settingsFile: string;
  stateDirectory: string;
};

/**
 * `hosts/<serverId>.json` beside the Agent configuration, and
 * `hosts/<serverId>` in the state folder.
 */
export function bohemiaHostLocations(
  serverId: string,
  locations: { configFile: string; stateDirectory: string },
): BohemiaHostLocations {
  const path = locations.configFile.includes('\\') ? win32 : posix;
  return {
    settingsFile: path.join(
      path.dirname(locations.configFile),
      'hosts',
      `${serverId}.json`,
    ),
    stateDirectory: path.join(locations.stateDirectory, 'hosts', serverId),
  };
}

export type BattlEyeProfileOptions = {
  /** Game host management. Without it, host routes are unsupported. */
  host?: BohemiaHostLocations;
  session?: Omit<BattlEyeSessionOptions, 'endpoint' | 'onMessage'>;
  reconnectMs?: number;
  /** A login quiet for longer is checked with a keep-alive before a write. Default 10 s, 0 always checks. */
  probeAfterMs?: number;
};

function invalidOperation(): AgentError {
  return new AgentError(
    400,
    'invalid-operation',
    'The operation is not valid for this server.',
  );
}

/**
 * Arma 3 and DayZ over a local BattlEye RCon login. The panel sends typed
 * operations only. The agent builds each command line, runs the checks and
 * the send in one login, and never sends a raw command.
 */
export function createBattlEyeProfile(
  server: BattlEyeServerConfig,
  options: BattlEyeProfileOptions = {},
): ProfileHandler {
  const events = new EventBuffer<{ at: number; text: string }>({
    maxItems: 2_000,
    maxBytes: 1024 * 1024,
  });
  const identities = new EventBuffer<{
    at: number;
    name: string;
    steamId: string;
  }>({
    maxItems: 1_000,
    maxBytes: 256 * 1024,
  });
  let password = '';

  async function endpoint() {
    if (!server.battleyeConfig)
      throw new AgentError(
        503,
        'not-configured',
        'Set battleyeConfig for this server.',
      );
    const file = await battleyeConfigFile(server.battleyeConfig);
    if (!file)
      throw new AgentError(
        503,
        'not-configured',
        'The BattlEye configuration file was not found.',
      );
    const settings = parseBattlEyeConfig(await readText(file));
    const port = server.rconPort ?? settings.port;
    if (!port)
      throw new AgentError(
        503,
        'not-configured',
        'The BattlEye configuration has no RConPort.',
      );
    password = checkedPassword(settings.password);
    return { host: rconHost(server.rconHost, settings.host), port, password };
  }

  const session = new BattlEyeSession({
    ...options.session,
    endpoint,
    onMessage: (text, at) =>
      events.push({ at, text: feedText(text, nativeFeedLineMaxChars) }),
  });
  let reconnect: NodeJS.Timeout | undefined;
  let tail: { close(): void } | undefined;
  let host: Promise<BohemiaHostController> | null = null;

  /** The host controller, created on first use from the settings file. */
  function hostController(): Promise<BohemiaHostController> {
    const locations = options.host;
    if (!locations)
      return Promise.reject(
        new AgentError(400, 'unsupported', 'Unsupported agent command.'),
      );
    host ??= (async () => {
      const { createBohemiaHostController, readBohemiaHostSettings } =
        await import('../games/bohemia-host');
      const settings = await readBohemiaHostSettings(locations.settingsFile);
      if (!settings)
        throw new AgentError(503, 'not-configured', 'Host settings missing.');
      return createBohemiaHostController({
        serverId: server.serverId,
        game: server.game,
        settings,
        stateDirectory: locations.stateDirectory,
        externalRunning: () => session.connected,
      });
    })();
    // A missing or invalid settings file is read again on the next request.
    host.catch(() => {
      host = null;
    });
    return host;
  }

  const probeAfterMs = options.probeAfterMs ?? 10_000;

  /** A login that stopped answering, for example after a game restart. */
  function deadLogin(error: unknown): boolean {
    return error instanceof ReplyMissing || error instanceof LoginChanged;
  }

  /**
   * A login that answers. A quiet login is checked with the protocol
   * keep-alive first. A dead login is replaced once. Use inside `exclusive`.
   */
  async function liveLogin(): Promise<number> {
    const epoch = await session.connectInLogin();
    if (probeAfterMs > 0 && session.answeredWithin(probeAfterMs)) return epoch;
    try {
      await session.commandInLogin('', epoch);
      return epoch;
    } catch (error) {
      if (!deadLogin(error)) throw error;
      return session.connectInLogin();
    }
  }

  /**
   * A read in a live login. When the login turns out to be dead, the agent
   * logs in again once and repeats the read, which changes nothing on the
   * server. Use inside `exclusive`.
   */
  async function readLive(
    command: string,
  ): Promise<{ epoch: number; reply: string }> {
    let epoch = await liveLogin();
    try {
      return { epoch, reply: await session.commandInLogin(command, epoch) };
    } catch (error) {
      if (!deadLogin(error)) throw error;
    }
    epoch = await session.connectInLogin();
    try {
      return { epoch, reply: await session.commandInLogin(command, epoch) };
    } catch (error) {
      if (deadLogin(error)) throw gameUnavailable();
      throw error;
    }
  }

  function read(command: string): Promise<NativeOperationResult> {
    return session.exclusive(async () => {
      const { reply } = await readLive(command);
      return { outcome: 'read', reply, observedAt: Date.now() };
    });
  }

  /** Send a write in `epoch`. A missing reply is reported, never retried. */
  async function send(
    epoch: number,
    line: string,
  ): Promise<NativeOperationResult> {
    try {
      return {
        outcome: 'sent',
        reply: await session.commandInLogin(line, epoch),
      };
    } catch (error) {
      if (error instanceof ReplyMissing) throw replyMissing();
      if (error instanceof LoginChanged) throw gameUnavailable();
      throw error;
    }
  }

  /**
   * Re-read `players`, then send only to the same verified GUID in the login
   * of that read. The write itself is never repeated.
   */
  function toPlayer(player: number, guid: string, line: string) {
    return session.exclusive(async (): Promise<NativeOperationResult> => {
      const { epoch, reply } = await readLive(battleyeReadCommands.players);
      const found = parseBattlEyePlayers(reply).find(
        (entry) => entry.number === player,
      );
      if (!found?.guidVerified || found.guid !== guid)
        return { outcome: 'target-changed' };
      return send(epoch, line);
    });
  }

  function run(op: BattlEyeOperation): Promise<NativeOperationResult> {
    switch (op.op) {
      case 'players':
        return read(battleyeReadCommands.players);
      case 'bans':
        return read(battleyeReadCommands.bans);
      case 'kickIfGuid':
        return toPlayer(op.player, op.guid, battleyeKick(op.player, op.reason));
      case 'sayIfGuid':
        return toPlayer(op.player, op.guid, battleyeSay(op.player, op.message));
      case 'broadcast': {
        const line = battleyeSay(-1, op.message);
        return session.exclusive(async () => send(await liveLogin(), line));
      }
      case 'addBan': {
        const line = battleyeAddBan(op.guid, op.minutes, op.reason);
        return session.exclusive(async () => send(await liveLogin(), line));
      }
      case 'removeBanForGuid':
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          const { epoch, reply } = await readLive(battleyeReadCommands.bans);
          const matches = parseBattlEyeGuidBans(reply).filter(
            (ban) => ban.guid === op.guid,
          );
          if (!matches.length) return { outcome: 'not-found' };
          // Removing the highest index keeps the indexes of the others.
          return send(
            epoch,
            battleyeRemoveBan(Math.max(...matches.map((ban) => ban.index))),
          );
        });
    }
  }

  return {
    profile: 'battleye',
    secrets: () => (password ? [password] : []),
    start() {
      const attempt = () => {
        if (!session.connected) void session.connect().catch(() => undefined);
      };
      attempt();
      reconnect = setInterval(attempt, options.reconnectMs ?? 15_000);
      reconnect.unref();
      // Arma 3 and DayZ name each joining player's Steam ID in the server
      // log (`.rpt`) of the `-profiles` folder.
      const readConnection = connectionReader(server.game);
      if (readConnection && server.logDirectory)
        tail = followNewestLog({
          directory: server.logDirectory,
          extension: '.rpt',
          onLine: (line) => {
            const found = readConnection(line);
            const name = found ? feedText(found.name, 128) : '';
            if (found && name)
              identities.push({
                at: Date.now(),
                name,
                steamId: found.steam64,
              });
          },
        });
    },
    async close() {
      if (host)
        await host.then(
          (controller) => controller.close(),
          () => {},
        );
      clearInterval(reconnect);
      tail?.close();
      session.close();
    },
    async handle(command: AgentCommand): Promise<CommandResponse> {
      const path = command.path.split('?')[0];
      try {
        if (command.method === 'POST' && command.path === nativePaths.op) {
          const op = parseNativeOperation(battleyeOperation, command.body);
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
        if (command.method === 'GET' && path === nativePaths.identity) {
          const page = identities.read(cursorOf(command.path));
          return jsonResponse(200, {
            cursor: page.cursor,
            entries: page.items,
            dropped: page.dropped,
          } satisfies NativeIdentityFeed);
        }
        if (path.startsWith(bohemiaHostPaths.prefix)) {
          const resource = path.slice(bohemiaHostPaths.prefix.length);
          if (
            command.method === 'POST' &&
            command.path === bohemiaHostPaths.command
          ) {
            let body: unknown;
            try {
              body = JSON.parse(command.body ?? 'null');
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
            (bohemiaHostResources as readonly string[]).includes(resource)
          ) {
            const query = new URLSearchParams(command.path.split('?')[1] ?? '');
            return jsonResponse(
              200,
              await (
                await hostController()
              ).read(resource as BohemiaHostResource, query),
            );
          }
        }
        return unsupportedRoute();
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
