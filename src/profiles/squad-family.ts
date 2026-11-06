import type { SquadServerConfig } from '../config';
import { AgentError } from '../errors';
import { ReplyMissing, gameUnavailable } from '../games/battleye-session';
import {
  checkedPassword,
  parseSquadRconConfig,
  rconHost,
  readText,
} from '../games/game-config';
import { feedText } from '../games/text';
import {
  SourceRconSession,
  type SourceRconSessionOptions,
} from '../games/source-rcon';
import {
  parseSquadPlayers,
  squadBan,
  squadBroadcast,
  squadKick,
  squadPlayersMentionOutsideIds,
  squadReadCommands,
  squadWarn,
} from '../games/squad-commands';
import {
  nativeFeedLineMaxChars,
  nativePaths,
  parseNativeOperation,
  squadOperation,
  type AgentCommand,
  type NativeEventFeed,
  type NativeIdentityFeed,
  type NativeOperationResult,
  type SquadOperation,
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

export type SquadProfileOptions = {
  session?: Omit<SourceRconSessionOptions, 'endpoint' | 'onMessage'>;
  reconnectMs?: number;
};

function invalidOperation(): AgentError {
  return new AgentError(
    400,
    'invalid-operation',
    'The operation is not valid for this server.',
  );
}

/**
 * Squad 44 and Beyond the Wire over one local Source RCON connection. These
 * servers accept one admin connection per address, so the agent holds it
 * and serves every operation and event through it.
 */
export function createSquadFamilyProfile(
  server: SquadServerConfig,
  options: SquadProfileOptions = {},
): ProfileHandler {
  const events = new EventBuffer<{ at: number; text: string }>({
    maxItems: 2_000,
    maxBytes: 1024 * 1024,
  });
  let password = '';

  async function endpoint() {
    if (!server.rconConfig)
      throw new AgentError(
        503,
        'not-configured',
        'Set rconConfig for this server.',
      );
    let text: string;
    try {
      text = await readText(server.rconConfig);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        503,
        'not-configured',
        'The Rcon.cfg file was not found.',
      );
    }
    const settings = parseSquadRconConfig(text);
    const port = server.rconPort ?? settings.port;
    if (!port)
      throw new AgentError(503, 'not-configured', 'Rcon.cfg has no Port.');
    password = checkedPassword(settings.password);
    return { host: rconHost(server.rconHost, settings.host), port, password };
  }

  const session = new SourceRconSession({
    ...options.session,
    endpoint,
    onMessage: (text, at) =>
      events.push({ at, text: feedText(text, nativeFeedLineMaxChars) }),
  });
  let reconnect: NodeJS.Timeout | undefined;

  /**
   * A read in the current connection. When the connection turns out to be
   * dead, the agent connects again once and repeats the read, which changes
   * nothing on the server. Use inside `exclusive`.
   */
  async function readLive(
    command: string,
  ): Promise<{ epoch: number; reply: string }> {
    let epoch = await session.connectInSession();
    try {
      return { epoch, reply: await session.commandInSession(command, epoch) };
    } catch (error) {
      if (!(error instanceof ReplyMissing)) throw error;
    }
    epoch = await session.connectInSession();
    try {
      return { epoch, reply: await session.commandInSession(command, epoch) };
    } catch (error) {
      if (error instanceof ReplyMissing) throw gameUnavailable();
      throw error;
    }
  }

  /** Send a write in `epoch`. A missing reply is reported, never retried. */
  async function send(
    epoch: number,
    line: string,
  ): Promise<NativeOperationResult> {
    try {
      return {
        outcome: 'sent',
        reply: await session.commandInSession(line, epoch),
      };
    } catch (error) {
      if (error instanceof ReplyMissing) throw replyMissing();
      throw error;
    }
  }

  /** Re-read `ListPlayers` in this connection, then send only to the same Steam ID. */
  function toPlayer(player: number, steamId: string, line: string) {
    return session.exclusive(async (): Promise<NativeOperationResult> => {
      const { epoch, reply } = await readLive(squadReadCommands.players);
      const found = parseSquadPlayers(reply).find(
        (entry) => entry.playerId === player,
      );
      if (
        !found?.identities.some(
          (identity) => identity.kind === 'steam' && identity.value === steamId,
        )
      )
        return { outcome: 'target-changed' };
      return send(epoch, line);
    });
  }

  function run(op: SquadOperation): Promise<NativeOperationResult> {
    switch (op.op) {
      case 'players':
        return session.exclusive(async () => {
          const { reply } = await readLive(squadReadCommands.players);
          return { outcome: 'read', reply, observedAt: Date.now() };
        });
      case 'kickIfSteamId':
        return toPlayer(op.player, op.steamId, squadKick(op.player, op.reason));
      case 'warnIfSteamId':
        return toPlayer(
          op.player,
          op.steamId,
          squadWarn(op.player, op.message),
        );
      case 'broadcast': {
        const line = squadBroadcast(op.message);
        return session.exclusive(async () =>
          send(await session.connectInSession(), line),
        );
      }
      case 'addBan': {
        const line = squadBan(op.steamId, op.days, op.reason);
        return session.exclusive(async (): Promise<NativeOperationResult> => {
          // AdminBan also matches names. Refuse while the ID appears outside an online ID block.
          const { epoch, reply: roster } = await readLive(
            squadReadCommands.players,
          );
          if (squadPlayersMentionOutsideIds(roster, op.steamId))
            return { outcome: 'target-changed' };
          return send(epoch, line);
        });
      }
      // Squad family RCON has no ban list and no unban.
      case 'bans':
      case 'removeBanForSteamId':
        return Promise.resolve({ outcome: 'unsupported' });
    }
  }

  return {
    profile: 'squad-family',
    secrets: () => (password ? [password] : []),
    start() {
      const attempt = () => {
        if (!session.connected)
          void session
            .exclusive(() => session.connectInSession())
            .catch(() => undefined);
      };
      attempt();
      reconnect = setInterval(attempt, options.reconnectMs ?? 15_000);
      reconnect.unref();
    },
    async close() {
      clearInterval(reconnect);
      session.close();
    },
    async handle(command: AgentCommand): Promise<CommandResponse> {
      const path = command.path.split('?')[0];
      try {
        if (command.method === 'POST' && command.path === nativePaths.op) {
          const op = parseNativeOperation(squadOperation, command.body);
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
          // The roster already carries Steam IDs.
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
