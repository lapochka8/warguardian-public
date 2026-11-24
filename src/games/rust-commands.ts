import { AgentError } from '../errors';
import { invalidText, validateGameText, type GameTextLimits } from './text';

/**
 * Rust console command lines, built on the host from typed operations. They
 * equal the lines the panel builds for a direct connection, and a test
 * compares the two. Targets are Steam64 IDs, never names.
 */

export const rustReadCommands = Object.freeze({
  players: 'playerlist',
  status: 'status',
  bans: 'banlistex',
} as const);

export const rustReasonLimits: GameTextLimits = Object.freeze({
  maxChars: 128,
  maxBytes: 512,
});
export const rustMessageLimits: GameTextLimits = Object.freeze({
  maxChars: 256,
  maxBytes: 1_024,
});
/** Characters that could end a quoted console value or start a command. */
export const rustForbiddenText = /["\\;]/u;

/** About ten years. A longer ban must be permanent. */
export const rustLongestTimedBanMinutes = 10 * 366 * 24 * 60;

const steam64Pattern = /^7656119\d{10}$/;

function invalid(message: string): AgentError {
  return new AgentError(400, 'invalid-operation', message);
}

export function rustText(text: string, limits: GameTextLimits): string {
  const valid = validateGameText(text, limits);
  if (rustForbiddenText.test(valid)) throw invalidText();
  return valid;
}

function steam64(value: string): string {
  if (typeof value !== 'string' || !steam64Pattern.test(value))
    throw invalid('A Rust command target is a Steam64 ID.');
  return value;
}

export function rustKick(target: string, reason: string): string {
  return `kick ${steam64(target)} "${rustText(reason, rustReasonLimits)}"`;
}

/** The name argument is the ID itself, so no player text reaches the list. */
export function rustBanId(
  target: string,
  minutes: number | 'permanent',
  reason: string,
): string {
  const id = steam64(target);
  const line = `banid ${id} "${id}" "${rustText(reason, rustReasonLimits)}"`;
  if (minutes === 'permanent') return line;
  if (
    !Number.isSafeInteger(minutes) ||
    minutes < 1 ||
    minutes > rustLongestTimedBanMinutes
  )
    throw invalid('A timed Rust ban lasts one minute to ten years.');
  return `${line} ${minutes}m`;
}

export function rustUnban(target: string): string {
  return `unban ${steam64(target)}`;
}

/** `say` prints its whole argument, quotes included, so none are sent. */
export function rustSay(text: string): string {
  return `say ${rustText(text, rustMessageLimits)}`;
}

export const rustSaveConfig = 'server.writecfg';

/** The settings a panel may read and set, and their console names. */
export const rustSettingConvars = Object.freeze({
  name: 'server.hostname',
  description: 'server.description',
  url: 'server.url',
  headerImage: 'server.headerimage',
  maxPlayers: 'server.maxplayers',
} as const);
export type RustSettingKey = keyof typeof rustSettingConvars;

const settingLimits: GameTextLimits = Object.freeze({
  maxChars: 500,
  maxBytes: 2_000,
});

export const rustToolLines = Object.freeze({
  save: 'server.save',
  restart: (seconds: number, reason?: string) => {
    if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 3_600)
      throw invalid('A restart countdown is 10 seconds to one hour.');
    return reason
      ? `restart ${seconds} "${rustText(reason, rustReasonLimits)}"`
      : `restart ${seconds}`;
  },
  restartCancel: 'restart -1',
  kickAll: (reason: string) =>
    `kickall "" "${rustText(reason, rustReasonLimits)}"`,
  mute: (target: string) => `mute ${steam64(target)}`,
  unmute: (target: string) => `unmute ${steam64(target)}`,
  setting: (key: RustSettingKey, value: string | number) => {
    if (key === 'maxPlayers') {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > 1_000
      )
        throw invalid('The player limit is a whole number.');
      return `${rustSettingConvars[key]} ${value}`;
    }
    if (typeof value !== 'string') throw invalid('The setting is text.');
    // An empty value clears the setting.
    return `${rustSettingConvars[key]} "${value === '' ? '' : rustText(value, settingLimits)}"`;
  },
  admin: (role: 'owner' | 'moderator', target: string) =>
    `${role === 'owner' ? 'ownerid' : 'moderatorid'} ${steam64(target)} "${steam64(target)}" "WarGuardian"`,
  removeAdmin: (role: 'owner' | 'moderator', target: string) =>
    `${role === 'owner' ? 'removeowner' : 'removemoderator'} ${steam64(target)}`,
  /**
   * The player comes first, then the item. A build 2636 server answered
   * `giving <name> <amount> x <item>` and told the chat about it.
   */
  give: (item: string, target: string, amount: number) => {
    if (
      !/^[a-z0-9][a-z0-9_.-]{0,59}$/.test(item) ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > 100_000
    )
      throw invalid('An item has a short name and an amount.');
    return `inventory.giveto ${steam64(target)} ${item} ${amount}`;
  },
  kill: (target: string) => `global.killplayer ${steam64(target)}`,
  teleport: (target: string, to: string) =>
    `teleport ${steam64(target)} ${steam64(to)}`,
  skipQueue: (target: string, allow: boolean) =>
    `${allow ? 'skipqueueid' : 'removeskipqueue'} ${steam64(target)}`,
  renderMap: (scale: number) => {
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 1)
      throw invalid('A map render has a scale of 0.1 to 1.');
    return `world.rendermap ${scale}`;
  },
  performance: 'serverinfo',
  positions: 'playerlistpos',
  worldSize: 'server.worldsize',
  lookup: (kind: 'combat' | 'team', target: string) =>
    `${kind === 'combat' ? 'combatlog' : 'teaminfo'} ${steam64(target)}`,
  pluginReload: (framework: 'oxide' | 'carbon', plugin: string) => {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(plugin))
      throw invalid('A plugin name has letters, digits, dots and dashes.');
    return `${framework === 'carbon' ? 'c' : 'oxide'}.reload ${plugin}`;
  },
});

/** The version and list commands of each plugin framework. */
export const rustFrameworks = Object.freeze([
  { id: 'carbon', name: 'Carbon', version: 'c.version', plugins: 'c.plugins' },
  {
    id: 'oxide',
    name: 'Oxide',
    version: 'oxide.version',
    plugins: 'oxide.plugins',
  },
] as const);

/**
 * What a `playerlist` reply says about one Steam64 ID: whether the player is
 * online, the player's name, and whether another online name contains the
 * ID. `kick` also matches names, so such a name could take the kick. An
 * unreadable reply gives null.
 */
export function rustPlayerState(
  reply: string,
  target: string,
): { online: boolean; name: string; shadowed: boolean; count: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(reply);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  let online = false;
  let name = '';
  let shadowed = false;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const fields = entry as Record<string, unknown>;
    if (
      typeof fields['SteamID'] !== 'string' ||
      typeof fields['DisplayName'] !== 'string'
    )
      return null;
    if (fields['SteamID'] === target) {
      online = true;
      name = fields['DisplayName'];
    }
    if (fields['DisplayName'].includes(target)) shadowed = true;
  }
  return { online, name, shadowed, count: value.length };
}

/** Whether a `banlistex` reply lists the Steam64 ID. */
export function rustBanListed(reply: string, target: string): boolean {
  return reply
    .split(/\r?\n/)
    .some((line) => new RegExp(`^\\d+\\s+${target}\\s`).test(line.trim()));
}
