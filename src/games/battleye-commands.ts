import { AgentError } from '../errors';
import { validateGameText, type GameTextLimits } from './text';

/**
 * BattlEye RCon command builders and reply parsers for Arma 3 and DayZ,
 * following the published BattlEye command list. Builders validate every
 * argument. Parsers anchor values to their columns and reject a reply whose
 * structure does not add up, so a player name cannot forge a row.
 */

export const battleyeTextLimits: GameTextLimits = {
  maxChars: 200,
  maxBytes: 400,
};

/** Minutes, or a permanent ban. */
export type BattlEyeBanLength = number | 'permanent';

const guidPattern = /^[0-9a-f]{32}$/;

export const battleyeReadCommands = Object.freeze({
  players: 'players',
  bans: 'bans',
  missions: 'missions',
} as const);

function invalid(message: string): AgentError {
  return new AgentError(400, 'invalid-operation', message);
}

function playerNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535)
    throw invalid('Choose a player number from the player list.');
  return String(value);
}

function banIndex(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    throw invalid('Choose a ban from the ban list.');
  return String(value);
}

function battleyeGuid(value: string): string {
  if (typeof value !== 'string' || !guidPattern.test(value))
    throw invalid('Enter a BattlEye GUID of 32 lowercase hex digits.');
  return value;
}

/** `0` is permanent in the BattlEye command list. A timed ban is at least one minute. */
function banMinutes(length: BattlEyeBanLength): string {
  if (length === 'permanent') return '0';
  if (!Number.isSafeInteger(length) || length < 1)
    throw invalid('A timed BattlEye ban needs a positive whole length.');
  return String(length);
}

function text(value: string): string {
  return validateGameText(value, battleyeTextLimits);
}

export function battleyeKick(player: number, reason: string): string {
  return `kick ${playerNumber(player)} ${text(reason)}`;
}

export function battleyeAddBan(
  guid: string,
  length: BattlEyeBanLength,
  reason: string,
): string {
  return `addBan ${battleyeGuid(guid)} ${banMinutes(length)} ${text(reason)}`;
}

export function battleyeRemoveBan(index: number): string {
  return `removeBan ${banIndex(index)}`;
}

/** A message to one player, or to everyone with `-1`. */
export function battleyeSay(target: number, message: string): string {
  return `say ${target === -1 ? '-1' : playerNumber(target)} ${text(message)}`;
}

export type BattlEyePlayer = {
  number: number;
  address: string;
  ping: number;
  guid: string | null;
  /** True only for a GUID the server marks `(OK)`. */
  guidVerified: boolean;
  name: string;
  lobby: boolean;
};

const playerRow =
  /^(\d{1,5})\s+(\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})\s+(-?\d{1,6})\s+(-|[0-9a-f]{32}\((?:OK|\?)\))(?:\s+(.*))?$/;
const playerTotal = /^\((\d{1,5}) players? in total\)$/;
const lobbySuffix = ' (Lobby)';

function unreadable(subject: string): AgentError {
  return new AgentError(
    502,
    'game-unavailable',
    `The game server sent ${subject} that could not be read.`,
  );
}

/**
 * Parse a `players` reply. The total line must appear once and match the
 * rows, and player numbers must be unique.
 */
export function parseBattlEyePlayers(reply: string): BattlEyePlayer[] {
  const players: BattlEyePlayer[] = [];
  const numbers = new Set<number>();
  let total: number | undefined;
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    const counted = playerTotal.exec(trimmed);
    if (counted) {
      if (total !== undefined) throw unreadable('a player list');
      total = Number(counted[1]);
      continue;
    }
    const row = playerRow.exec(line);
    if (!row) continue;
    const number = Number(row[1]);
    if (numbers.has(number)) throw unreadable('a player list');
    numbers.add(number);
    const column = row[4]!;
    let name = (row[5] ?? '').trimEnd();
    const lobby = name.endsWith(lobbySuffix);
    if (lobby) name = name.slice(0, -lobbySuffix.length);
    players.push({
      number,
      address: row[2]!,
      ping: Number(row[3]),
      guid: column === '-' ? null : column.slice(0, 32),
      guidVerified: column.endsWith('(OK)'),
      name,
      lobby,
    });
  }
  if (total === undefined || total !== players.length)
    throw unreadable('a player list');
  return players;
}

export type BattlEyeGuidBan = { index: number; guid: string };

const banRow = /^(\d{1,7})\s+(\S+)\s+(perm|-|\d{1,9})(?:\s+(.*))?$/;

/** The GUID entries of a `bans` reply. IP entries are checked and skipped. */
export function parseBattlEyeGuidBans(reply: string): BattlEyeGuidBan[] {
  const bans: BattlEyeGuidBan[] = [];
  const indexes = new Set<number>();
  let section: 'guid' | 'ip' | undefined;
  let sawGuidSection = false;
  for (const raw of reply.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || /^-+$/.test(line) || line.startsWith('[#]')) continue;
    if (line === 'GUID Bans:') {
      if (section !== undefined) throw unreadable('a ban list');
      section = 'guid';
      sawGuidSection = true;
      continue;
    }
    if (line === 'IP Bans:') {
      if (section === 'ip') throw unreadable('a ban list');
      section = 'ip';
      continue;
    }
    const row = banRow.exec(line);
    if (!row || !section) throw unreadable('a ban list');
    const index = Number(row[1]);
    if (indexes.has(index)) throw unreadable('a ban list');
    indexes.add(index);
    if (section === 'guid') {
      if (!guidPattern.test(row[2]!)) throw unreadable('a ban list');
      bans.push({ index, guid: row[2]! });
    }
  }
  if (!sawGuidSection) throw unreadable('a ban list');
  return bans;
}
