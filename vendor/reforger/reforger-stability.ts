import { promises as fs } from 'node:fs';

export type ReforgerStatsSample = {
  fps: number;
  frameAvgMs: number | null;
  frameMinMs: number | null;
  frameMaxMs: number | null;
  memoryKb: number | null;
  players: number | null;
  ai: number | null;
  aiCharacters: number | null;
  vehicles: number | null;
};

const number = (value: string | undefined) => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Parses the line written by the dedicated server's `-logStats` option, e.g.
 * `FPS: 60.1, frame time (avg: 16.6 ms, min: 15.0 ms, max: 19.2 ms), Mem: 4896197 kB, Player: 1, AI: 1156, AIChar: 849, Veh: 0 (5), ...`.
 * Fields that a build does not print stay null. */
export function parseReforgerStatsLine(
  line: string,
): ReforgerStatsSample | null {
  const fps = /\bFPS:\s*([\d.]+)/.exec(line);
  if (!fps || !/\bMem:\s*\d+\s*kB/.test(line)) return null;
  const frame = /frame time \(([^)]*)\)/.exec(line)?.[1] ?? '';
  const timing = (name: 'avg' | 'min' | 'max') =>
    number(
      {
        avg: /\bavg:\s*([\d.]+)\s*ms/,
        min: /\bmin:\s*([\d.]+)\s*ms/,
        max: /\bmax:\s*([\d.]+)\s*ms/,
      }[name].exec(frame)?.[1],
    );
  const value = number(fps[1]);
  if (value === null || value < 0 || value > 10000) return null;
  return {
    fps: value,
    frameAvgMs: timing('avg'),
    frameMinMs: timing('min'),
    frameMaxMs: timing('max'),
    memoryKb: number(/\bMem:\s*(\d+)\s*kB/.exec(line)?.[1]),
    players: number(/\bPlayer:\s*(\d+)/.exec(line)?.[1]),
    ai: number(/\bAI:\s*(\d+)/.exec(line)?.[1]),
    aiCharacters: number(/\bAIChar:\s*(\d+)/.exec(line)?.[1]),
    vehicles: number(/\bVeh:\s*(\d+)/.exec(line)?.[1]),
  };
}

/** Matches the engine freeze report `Application hangs (force crash) N s`. */
export function parseReforgerHang(line: string) {
  const match = /Application hangs(?: \(force crash\))?\s*([\d.]+)?\s*s?/i.exec(
    line,
  );
  if (!match) return null;
  return { seconds: number(match[1]), line: line.trim().slice(0, 300) };
}

export type ReforgerConsoleScan = {
  stats: ReforgerStatsSample[];
  hangs: { seconds: number | null; line: string }[];
  game: ReforgerGameLine[];
};

/** Follows the connector's console file from its current end. Earlier output
 * is never replayed, so samples carry the time they were observed. */
export async function createReforgerConsoleWatcher(path: string) {
  let offset = 0,
    pending = '';
  try {
    offset = (await fs.stat(path)).size;
  } catch {
    offset = 0;
  }
  return {
    async scan(): Promise<ReforgerConsoleScan> {
      let size: number;
      try {
        size = (await fs.stat(path)).size;
      } catch {
        return { stats: [], hangs: [], game: [] };
      }
      if (size < offset) {
        offset = 0;
        pending = '';
      }
      if (size === offset) return { stats: [], hangs: [], game: [] };
      const length = Math.min(size - offset, 1048576),
        start = size - offset > 1048576 ? size - length : offset;
      const handle = await fs.open(path, 'r');
      let text = '';
      try {
        const bytes = Buffer.alloc(length);
        const read = await handle.read(bytes, 0, length, start);
        text = bytes.subarray(0, read.bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      offset = size;
      const lines = (pending + text).split(/\r?\n/);
      pending = (lines.pop() ?? '').slice(-4096);
      const result: ReforgerConsoleScan = { stats: [], hangs: [], game: [] };
      for (const line of lines) {
        const stats = parseReforgerStatsLine(line);
        if (stats) {
          result.stats.push(stats);
          continue;
        }
        const hang = parseReforgerHang(line);
        if (hang) {
          result.hangs.push(hang);
          continue;
        }
        const game = parseReforgerGameLine(line);
        if (game) result.game.push(game);
      }
      return result;
    },
  };
}

export type ReforgerGameLine =
  | {
      kind: 'vote-started';
      initiator: string;
      initiatorPlayerId: number;
      target: string;
      targetPlayerId: number;
    }
  | { kind: 'vote-succeeded'; target: string; targetPlayerId: number }
  | { kind: 'round-started' }
  | { kind: 'round-ended' }
  | {
      kind: 'player-identity';
      playerId: number;
      name: string;
      identityId: string;
    }
  | { kind: 'be-adding'; beIdentity: string; name: string }
  | { kind: 'be-connected'; playerNumber: number; name: string; ip: string }
  | { kind: 'be-platform'; beIdentity: string; platformId: string }
  | { kind: 'be-guid'; playerNumber: number; name: string; beGuid: string }
  | { kind: 'be-disconnected'; playerNumber: number; name: string }
  | { kind: 'sat-kill'; victim: string; instigator: string; friendly: boolean }
  | { kind: 'sat-base-captured'; faction: string; base: string }
  | { kind: 'sat-admin-action'; action: string; admin: string; player: string }
  | { kind: 'sat-game-ended'; reason: string; winner: string }
  | { kind: 'sat-player-joined'; player: string; identityId: string }
  | {
      kind: 'sat-vote-started';
      initiator: string;
      type: string;
      target: string;
    }
  | { kind: 'sat-vote-ended'; winner: string; type: string; target: string };

const clip = (value: string, length = 120) => value.trim().slice(0, length);
/** Recognises the vanilla, BattlEye and Server Admin Tools lines that the
 * dedicated server writes to its console. Formats follow the ReforgerJS
 * parsers and published server logs. */
export function parseReforgerGameLine(line: string): ReforgerGameLine | null {
  let match =
    /VOTING SYSTEM - Player '(.*?)' \(with player id = (\d+)\) started a vote to kick player '(.*?)' \(with player id = (\d+)\)/.exec(
      line,
    );
  if (match)
    return {
      kind: 'vote-started',
      initiator: clip(match[1]),
      initiatorPlayerId: Number(match[2]),
      target: clip(match[3]),
      targetPlayerId: Number(match[4]),
    };
  match =
    /VOTING SYSTEM - Vote to kick player '(.*?)' \(with player id = (\d+)\) succeeded/.exec(
      line,
    );
  if (match)
    return {
      kind: 'vote-succeeded',
      target: clip(match[1]),
      targetPlayerId: Number(match[2]),
    };
  match = /SCR_BaseGameMode::OnGameStateChanged\s+=\s+(POSTGAME|GAME)\b/.exec(
    line,
  );
  if (match)
    return { kind: match[1] === 'GAME' ? 'round-started' : 'round-ended' };
  match =
    /### Updating player: PlayerId=(\d+), Name=(.*?), IdentityId=([a-f0-9-]{36})/i.exec(
      line,
    );
  if (match)
    return {
      kind: 'player-identity',
      playerId: Number(match[1]),
      name: clip(match[2]),
      identityId: match[3].toLowerCase(),
    };
  match =
    /BattlEye Server: Adding player identity=(0x[0-9a-fA-F]+), name='(.+?)'/.exec(
      line,
    );
  if (match)
    return { kind: 'be-adding', beIdentity: match[1], name: clip(match[2]) };
  match =
    /BattlEye Server: 'Player\s+#(\d+)\s+(.*?)\s+\(([^):]+)(?::\d+)?\)\s+connected'/.exec(
      line,
    );
  if (match)
    return {
      kind: 'be-connected',
      playerNumber: Number(match[1]),
      name: clip(match[2]),
      ip: match[3].trim().slice(0, 64),
    };
  match =
    /BattlEye Server: Setting GUID for player identity=(0x[0-9a-fA-F]+), GUID=(.+)$/.exec(
      line,
    );
  if (match)
    return {
      kind: 'be-platform',
      beIdentity: match[1],
      platformId: match[2].trim().slice(0, 64),
    };
  match =
    /BattlEye Server: 'Player\s+#(\d+)\s+(.*?)\s+-\s+BE\s+GUID:\s+([a-fA-F0-9]{32})'/.exec(
      line,
    );
  if (match)
    return {
      kind: 'be-guid',
      playerNumber: Number(match[1]),
      name: clip(match[2]),
      beGuid: match[3].toLowerCase(),
    };
  match = /BattlEye Server: 'Player\s+#(\d+)\s+(.*?)\s+disconnected'/.exec(
    line,
  );
  if (match)
    return {
      kind: 'be-disconnected',
      playerNumber: Number(match[1]),
      name: clip(match[2]),
    };
  match =
    /ServerAdminTools \| Event serveradmintools_player_killed \| player: (.*?), instigator: (.*?), friendly: (true|false)/.exec(
      line,
    );
  if (match)
    return {
      kind: 'sat-kill',
      victim: clip(match[1]),
      instigator: clip(match[2]),
      friendly: match[3] === 'true',
    };
  match =
    /ServerAdminTools \| Event serveradmintools_conflict_base_captured \|\s+faction: ([^,]+), base: (.+)/.exec(
      line,
    );
  if (match)
    return {
      kind: 'sat-base-captured',
      faction: clip(match[1], 60),
      base: clip(match[2]),
    };
  match =
    /ServerAdminTools \| Event serveradmintools_admin_action \| action: ([^,]+), admin: (.*?), player: (.+)/.exec(
      line,
    );
  if (match)
    return {
      kind: 'sat-admin-action',
      action: clip(match[1], 60),
      admin: clip(match[2]),
      player: clip(match[3]),
    };
  match =
    /ServerAdminTools \| Event serveradmintools_game_ended \|\s+reason: ([^,]+), winner: (.+)/.exec(
      line,
    );
  if (match)
    return {
      kind: 'sat-game-ended',
      reason: clip(match[1], 60),
      winner: clip(match[2], 60),
    };
  match =
    /ServerAdminTools \| Event serveradmintools_player_joined \| player: (.*?), identity: ([a-f0-9-]{36})/i.exec(
      line,
    );
  if (match)
    return {
      kind: 'sat-player-joined',
      player: clip(match[1]),
      identityId: match[2].toLowerCase(),
    };
  match =
    /ServerAdminTools \| Event serveradmintools_vote_(started|ended) \| (?:initiator|winner): (.*?), type: (.*?), target: (.+)/.exec(
      line,
    );
  if (match)
    return match[1] === 'started'
      ? {
          kind: 'sat-vote-started',
          initiator: clip(match[2]),
          type: clip(match[3], 60),
          target: clip(match[4]),
        }
      : {
          kind: 'sat-vote-ended',
          winner: clip(match[2]),
          type: clip(match[3], 60),
          target: clip(match[4]),
        };
  return null;
}

export type ReforgerGameEvent = {
  kind:
    | 'vote-started'
    | 'vote-succeeded'
    | 'vote-ended'
    | 'round-started'
    | 'round-ended'
    | 'player-link'
    | 'player-left'
    | 'kill'
    | 'base-captured'
    | 'admin-action';
  data: Record<string, string | number | boolean | null>;
};
type PendingJoin = {
  name: string;
  at: number;
  ip?: string;
  platformId?: string;
  beGuid?: string;
};
/** A join and an identity line pair only within this window. */
const pairingWindowMs = 180000;
/** Joins BattlEye connection lines with the native identity line that follows
 * them. Network addresses are replaced by a keyed hash before they leave the
 * host, so linked accounts can be compared without storing an address.
 *
 * The lines pair by player name. A link is `unique` only when exactly one
 * recent join has the name and no other identity used the name in the last
 * 180 seconds; otherwise it is `ambiguous`, and the server never uses its
 * BattlEye, platform or network detail, which may belong to the other
 * player. */
export function createReforgerGameEventAssembler(
  hashAddress: (ip: string) => string,
  now: () => number = Date.now,
) {
  const pending = new Map<string, PendingJoin>(),
    identities = new Map<string, string>(),
    recent: { name: string; identityId: string; at: number }[] = [];
  const byName = (name: string) =>
    [...pending.values()].find((join) => join.name === name);
  const remember = (name: string, identityId: string, at: number) => {
    identities.delete(name);
    identities.set(name, identityId);
    while (identities.size > 500)
      identities.delete(identities.keys().next().value!);
    recent.push({ name, identityId, at });
    while (
      recent.length > 1000 ||
      (recent.length && at - recent[0].at > pairingWindowMs)
    )
      recent.shift();
  };
  function link(
    join: PendingJoin,
    identityId: string | null,
    playerId: number | null,
    pairing?: 'unique' | 'ambiguous',
  ): ReforgerGameEvent {
    const steam = !!join.platformId && /^\d{17}$/.test(join.platformId);
    return {
      kind: 'player-link',
      data: {
        name: join.name,
        identityId,
        playerId,
        beGuid: join.beGuid ?? null,
        platformId: steam ? join.platformId! : null,
        device: join.platformId ? (steam ? 'pc' : 'console') : null,
        network: join.ip ? hashAddress(join.ip) : null,
        ...(pairing ? { pairing } : {}),
      },
    };
  }
  const identity = (name: string) => identities.get(name) ?? null;
  return {
    push(lines: ReforgerGameLine[]): ReforgerGameEvent[] {
      const events: ReforgerGameEvent[] = [];
      const at = now();
      for (const line of lines) {
        if (line.kind === 'be-adding')
          pending.set(line.beIdentity, { name: line.name, at });
        else if (line.kind === 'be-connected') {
          const join = byName(line.name);
          if (join) join.ip = line.ip;
        } else if (line.kind === 'be-platform') {
          const join = pending.get(line.beIdentity);
          if (join) join.platformId = line.platformId;
        } else if (line.kind === 'be-guid') {
          const join = byName(line.name);
          if (join) join.beGuid = line.beGuid;
        } else if (
          line.kind === 'player-identity' ||
          line.kind === 'sat-player-joined'
        ) {
          const name =
            line.kind === 'player-identity' ? line.name : line.player;
          const otherIdentity = recent.some(
            (item) =>
              item.name === name &&
              item.identityId !== line.identityId &&
              at - item.at <= pairingWindowMs,
          );
          remember(name, line.identityId, at);
          // A join older than the window belongs to someone else, e.g. a
          // player who left before a renamed player took the name.
          const joins = [...pending.entries()]
            .filter(
              ([, join]) =>
                join.name === name && at - join.at <= pairingWindowMs,
            )
            .sort((a, b) => a[1].at - b[1].at);
          const entry = joins[0];
          if (entry) {
            pending.delete(entry[0]);
            events.push(
              link(
                entry[1],
                line.identityId,
                line.kind === 'player-identity' ? line.playerId : null,
                joins.length === 1 && !otherIdentity ? 'unique' : 'ambiguous',
              ),
            );
          }
        } else if (line.kind === 'be-disconnected')
          events.push({
            kind: 'player-left',
            data: { name: line.name, identityId: identity(line.name) },
          });
        else if (
          line.kind === 'vote-started' ||
          line.kind === 'sat-vote-started'
        )
          events.push({
            kind: 'vote-started',
            data: {
              source:
                line.kind === 'vote-started' ? 'vanilla' : 'server-admin-tools',
              initiator: line.initiator,
              initiatorIdentity: identity(line.initiator),
              target: line.target,
              targetIdentity: identity(line.target),
              type: line.kind === 'vote-started' ? 'kick' : line.type,
            },
          });
        else if (line.kind === 'vote-succeeded')
          events.push({
            kind: 'vote-succeeded',
            data: {
              target: line.target,
              targetIdentity: identity(line.target),
              type: 'kick',
            },
          });
        else if (line.kind === 'sat-vote-ended')
          events.push({
            kind: 'vote-ended',
            data: { winner: line.winner, target: line.target, type: line.type },
          });
        else if (line.kind === 'round-started' || line.kind === 'round-ended')
          events.push({ kind: line.kind, data: {} });
        else if (line.kind === 'sat-game-ended')
          events.push({
            kind: 'round-ended',
            data: { reason: line.reason, winner: line.winner },
          });
        else if (line.kind === 'sat-kill')
          events.push({
            kind: 'kill',
            data: {
              victim: line.victim,
              victimIdentity: identity(line.victim),
              killer: line.instigator,
              killerIdentity:
                line.instigator === 'AI' ? null : identity(line.instigator),
              friendly: line.friendly,
              suicide: line.victim === line.instigator,
            },
          });
        else if (line.kind === 'sat-base-captured')
          events.push({
            kind: 'base-captured',
            data: { faction: line.faction, base: line.base },
          });
        else if (line.kind === 'sat-admin-action')
          events.push({
            kind: 'admin-action',
            data: {
              action: line.action,
              admin: line.admin,
              player: line.player,
              playerIdentity: identity(line.player),
            },
          });
      }
      for (const [key, join] of pending)
        if (at - join.at > 180000) {
          pending.delete(key);
          if (join.beGuid || join.ip) events.push(link(join, null, null));
        }
      return events;
    },
  };
}
