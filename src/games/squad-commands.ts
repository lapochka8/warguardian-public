import { AgentError } from '../errors';
import { validateUnrealText, type GameTextLimits } from './text';

/**
 * Squad family RCON command builders and the `ListPlayers` reader, from the
 * admin commands on the Squad wiki Server Administration page. Squad 44 and
 * Beyond the Wire share them. Player numbers come from a fresh
 * `ListPlayers`, and bans take a Steam64 ID, never a name.
 */

export const squadReadCommands = Object.freeze({
  players: 'ListPlayers',
} as const);

export const squadReasonLimits: GameTextLimits = Object.freeze({
  maxChars: 200,
  maxBytes: 600,
});
export const squadMessageLimits: GameTextLimits = Object.freeze({
  maxChars: 300,
  maxBytes: 900,
});

const steam64Pattern = /^7656119\d{10}$/;
const epicPattern = /^[0-9A-Fa-f]{32}$/;

function invalid(message: string): AgentError {
  return new AgentError(400, 'invalid-operation', message);
}

/** Text within the limits, without Unreal console syntax characters. */
export function squadText(text: string, limits: GameTextLimits): string {
  return validateUnrealText(
    validateUnrealText(text, squadMessageLimits),
    limits,
  );
}

function playerNumber(playerId: number): string {
  if (!Number.isSafeInteger(playerId) || playerId < 0 || playerId > 999_999)
    throw invalid('A Squad player number is a whole number.');
  return String(playerId);
}

/** `0` only for a permanent ban. A timed ban is a whole number of days. */
export function squadBanLengthText(days: number | 'permanent'): string {
  if (days === 'permanent') return '0';
  if (!Number.isSafeInteger(days) || days < 1)
    throw invalid('A timed Squad ban lasts at least one day.');
  return `${days}d`;
}

export function squadKick(playerId: number, reason: string): string {
  return `AdminKickById ${playerNumber(playerId)} ${squadText(reason, squadReasonLimits)}`;
}

export function squadBan(
  steam64: string,
  days: number | 'permanent',
  reason: string,
): string {
  if (typeof steam64 !== 'string' || !steam64Pattern.test(steam64))
    throw invalid('A Squad ban takes a 17-digit Steam64 ID.');
  return `AdminBan ${steam64} ${squadBanLengthText(days)} ${squadText(reason, squadReasonLimits)}`;
}

export function squadWarn(playerId: number, text: string): string {
  return `AdminWarnById ${playerNumber(playerId)} ${squadText(text, squadMessageLimits)}`;
}

export function squadBroadcast(text: string): string {
  return `AdminBroadcast ${squadText(text, squadMessageLimits)}`;
}

export type SquadPlayerIdentity = { kind: 'steam' | 'eos'; value: string };
export type SquadPlayer = {
  playerId: number;
  name: string;
  identities: SquadPlayerIdentity[];
};

/** Read ` EOS: <32 hex> steam: <Steam64>`. Each label once, nothing else. */
export function squadOnlineIdentities(
  segment: string,
): SquadPlayerIdentity[] | null {
  const tokens = segment.split(' ').filter((token) => token.length > 0);
  if (tokens.length % 2) return null;
  let steam: string | undefined;
  let epic: string | undefined;
  for (let index = 0; index < tokens.length; index += 2) {
    const label = tokens[index];
    const value = tokens[index + 1]!;
    if (label === 'steam:' && steam === undefined && steam64Pattern.test(value))
      steam = value;
    else if (label === 'EOS:' && epic === undefined && epicPattern.test(value))
      epic = value;
    else return null;
  }
  const identities: SquadPlayerIdentity[] = [];
  if (steam) identities.push({ kind: 'steam', value: steam });
  if (epic) identities.push({ kind: 'eos', value: epic });
  return identities;
}

const activePlayerLine =
  /^ID: (\d{1,6}) \| Online IDs:([^|]*) \| Name: (.*) \| Team ID: (\d{1,3}|N\/A) \| Squad ID: (\d{1,4}|N\/A) \| Is Leader: (True|False) \| Role: ([^|]*)$/;
const activePlayersHeader = /^-+ ?Active Players ?-+$/;
const disconnectedHeader = /^-+ ?Recently Disconnected Players\b/;

/**
 * The active players of a `ListPlayers` reply. A player number or identity
 * that appears on two lines drops every such line.
 */
export function parseSquadPlayers(text: string): SquadPlayer[] {
  let section: 'none' | 'active' | 'disconnected' = 'none';
  let sawActive = false;
  const candidates: SquadPlayer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (activePlayersHeader.test(trimmed)) {
      section = 'active';
      sawActive = true;
      continue;
    }
    if (disconnectedHeader.test(trimmed)) {
      section = 'disconnected';
      continue;
    }
    if (section !== 'active') continue;
    const match = activePlayerLine.exec(line);
    const identities = match ? squadOnlineIdentities(match[2]!) : null;
    if (match && identities)
      candidates.push({
        playerId: Number(match[1]),
        name: match[3]!,
        identities,
      });
  }
  if (!sawActive)
    throw new AgentError(
      502,
      'game-unavailable',
      'The game server sent a player list that could not be read.',
    );
  const keys = (player: SquadPlayer) => [
    `player:${player.playerId}`,
    ...player.identities.map(
      (identity) => `${identity.kind}:${identity.value.toLowerCase()}`,
    ),
  ];
  const uses = new Map<string, number>();
  for (const player of candidates)
    for (const key of keys(player)) uses.set(key, (uses.get(key) ?? 0) + 1);
  return candidates.filter((player) =>
    keys(player).every((key) => uses.get(key) === 1),
  );
}

const onlineIdBlock = /^ID: \d{1,6} \| Online IDs:[^|]* \| /;

/**
 * True when the reply holds `value` anywhere except the online ID block at
 * the start of a player line. `AdminBan` also matches names, so a ban is
 * unsafe while this holds.
 */
export function squadPlayersMentionOutsideIds(
  text: string,
  value: string,
): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(value)) continue;
    const block = onlineIdBlock.exec(line);
    if (!block || line.slice(block[0].length).includes(value)) return true;
  }
  return false;
}
