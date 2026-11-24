import { z } from 'zod';
import {
  bohemiaHostBackups,
  bohemiaHostConfig,
  bohemiaHostLogs,
  bohemiaHostPaths,
  bohemiaHostReceipt,
  bohemiaHostStatus,
  bohemiaLogName,
} from './bohemia-host';

/**
 * The game host contract of Rust between the panel and the WarGuardian
 * Agent. It shares the routes, the receipt and the shapes of status, config,
 * logs and backups with the Arma 3 and DayZ host, so one screen serves every
 * game. Rust adds the game update, wipes and plugin files. The Agent builds
 * every process argument and file path itself. It runs no shell and accepts
 * no raw command, path or argument.
 */

export const rustHostResources = [
  'status',
  'config',
  'logs',
  'backups',
  'plugins',
  'admins',
  'map',
  'plugin-config',
] as const;
export type RustHostResource = (typeof rustHostResources)[number];

/** The largest config file the editor reads or writes. It fits one relay command. */
export const rustConfigMaxBytes = 49_152;
/**
 * The largest plugin settings file the editor reads or writes. The file and
 * its JSON escapes must fit one relay command of 64 KiB.
 */
export const rustPluginConfigMaxBytes = 40_960;
/** The largest log page. */
export const rustLogPageMax = 131_072;
/** The placeholder that keeps the stored RCON password unchanged. */
export const rustSecretPlaceholder = '[unchanged secret]';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const confirmation = z.string().trim().min(1).max(120);
const backupId = z.string().regex(/^[a-z0-9-]{1,80}$/);
/** A plugin by its file name without the `.cs` ending. */
export const rustPluginName = z.string().regex(/^[A-Za-z0-9_]{1,80}$/);

/** The folder of the plugin settings files, below the framework folder. */
export const rustPluginConfigFolder = {
  oxide: 'config',
  carbon: 'configs',
} as const;

/**
 * The text of a plugin settings file as it may be saved: JSON within the
 * size limit. Null for any other text.
 */
export function rustPluginConfigText(text: string): string | null {
  if (new TextEncoder().encode(text).length > rustPluginConfigMaxBytes)
    return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return text;
}

/** The largest plugin file staff can upload: 1 MiB. */
export const rustPluginUploadMaxBytes = 1_048_576;
/**
 * The largest part of an uploaded plugin in one relay command. The part
 * travels as Base64 inside a command of at most 64 KiB.
 */
export const rustPluginUploadChunkBytes = 40_960;

/**
 * The plugin name of an uploaded file: the file name without `.cs`. Null
 * for any other ending and for a name an install would not take. The name
 * holds letters, digits and underscores only, so it cannot leave a folder.
 */
export function rustPluginFileName(fileName: string): string | null {
  const match = /^([A-Za-z0-9_]{1,80})\.cs$/.exec(fileName);
  return match ? match[1]! : null;
}

/**
 * Why a file cannot be a plugin, or null when it can. A plugin is one C#
 * source file: UTF-8 text without a NUL byte that names its plugin class.
 * The text is never run or parsed here. An archive, a library and any other
 * binary file fail these checks.
 */
export function rustPluginFileProblem(file: Uint8Array): string | null {
  if (!file.length) return 'The file is empty.';
  if (file.length > rustPluginUploadMaxBytes)
    return 'The file is larger than 1 MiB.';
  if (file.includes(0)) return 'The file is not a plugin source file.';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file);
  } catch {
    return 'The file is not a plugin source file.';
  }
  return /\bnamespace\s+(?:Oxide|Carbon)\.Plugins\b/.test(text)
    ? null
    : 'The file is not a plugin source file.';
}

/** Base64 of at most `bytes` bytes, with padding. */
const base64 = (bytes: number) =>
  z
    .string()
    .max(Math.ceil(bytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

/**
 * `POST /api/native/host?upload=plugin`: one plugin file from the browser.
 * The panel checks it and passes it to the game host.
 */
export const rustPluginUpload = z.strictObject({
  upload: z.strictObject({
    fileName: z.string().max(120),
    data: base64(rustPluginUploadMaxBytes),
    confirmation: z.string().trim().min(1).max(120),
  }),
});
/** The largest body of a plugin upload request. */
export const rustPluginUploadBodyMax = 1_500_000;

/** What an update of every plugin did with one plugin. */
export const rustPluginUpdateResults = [
  'updated',
  'current',
  'not-listed',
  'failed',
  'skipped',
] as const;
export type RustPluginUpdateResult = (typeof rustPluginUpdateResults)[number];

const pluginUpdates = z
  .array(
    z.object({
      name: z.string().max(80),
      result: z.enum(rustPluginUpdateResults),
      /**
       * Whether the game server confirmed the reload of an updated plugin.
       * Absent from a host that does not reload after an update.
       */
      reloaded: z.boolean().optional(),
    }),
  )
  .max(500);
export type RustPluginUpdates = z.infer<typeof pluginUpdates>;

/**
 * What a wipe removes from the server's save folder:
 *
 * - `map`: the map and its save files. Players keep their blueprints.
 * - `blueprints`: the blueprints of every player. The map stays.
 * - `full`: the map and every player database, blueprints included.
 */
export const rustWipeKinds = ['map', 'blueprints', 'full'] as const;
export type RustWipeKind = (typeof rustWipeKinds)[number];

/** The side of the world in meters, as `server.worldsize` takes it. */
export const rustWorldSize = z.number().int().min(1_000).max(6_000);
/** The sizes the wipe form offers. */
export const rustWorldSizes = [
  1_000, 2_000, 3_000, 3_500, 4_000, 4_250, 4_500, 5_000, 6_000,
] as const;

/** The longest address of a custom map. */
export const rustLevelUrlMax = 300;

/**
 * Whether a text is the address of a custom map as WarGuardian takes it:
 * HTTPS, without a login, and a path that ends in `.map` before any query.
 * Rust loads the map from `+server.levelurl`. The Facepunch wiki page
 * "Hosting a custom map" asks for a direct download link.
 */
export function isRustLevelUrl(value: string): boolean {
  if (
    value.length > rustLevelUrlMax ||
    !value.startsWith('https://') ||
    /[\s"\\;#\p{Cc}]/u.test(value)
  )
    return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    /\.map$/i.test(url.pathname)
  );
}
export const rustLevelUrl = z
  .string()
  .max(rustLevelUrlMax)
  .refine(isRustLevelUrl);

export const rustFrameworkNames = ['carbon', 'oxide'] as const;
export type RustFrameworkName = (typeof rustFrameworkNames)[number];

/** The save files a wipe removes, by name, from the identity folder only. */
export function rustWipeFile(name: string, kind: RustWipeKind): boolean {
  if (kind === 'blueprints')
    return /^player\.blueprints\.[A-Za-z0-9.]*db(?:-wal|-shm|-journal)?$/i.test(
      name,
    );
  // The map, its saves and the files the server builds from the map.
  if (
    /\.(?:map|sav)(?:\.\d+)?$/i.test(name) ||
    /\.navmesh$/i.test(name) ||
    /_[a-z]+_\d+\.dat$/i.test(name)
  )
    return true;
  return (
    kind === 'full' &&
    /^(?:player\.(?:blueprints|deaths|identities|states|tokens)|sv\.files)\.[A-Za-z0-9.]*db(?:-wal|-shm|-journal)?$/i.test(
      name,
    )
  );
}

export const rustHostCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('stop'), confirmation }).strict(),
  z.object({ action: z.literal('restart'), confirmation }).strict(),
  /** Stop, update the game with SteamCMD, then start again if it ran. */
  z.object({ action: z.literal('update'), confirmation }).strict(),
  z
    .object({
      action: z.literal('save-config'),
      revision,
      text: z.string().max(rustConfigMaxBytes),
    })
    .strict(),
  /**
   * Stop, back up, remove the save files, then start again if it ran.
   * `seed` sets a new map seed for a server whose seed the Agent sets.
   */
  z
    .object({
      action: z.literal('wipe'),
      kind: z.enum(rustWipeKinds),
      seed: z.number().int().min(1).max(2_147_483_647).optional(),
      /** A new world size, for a server whose size the Agent sets. */
      worldSize: rustWorldSize.optional(),
      /**
       * The address of a custom map. The server then loads this map and
       * takes no seed and no world size. Empty returns to a procedural map.
       */
      levelUrl: z.union([rustLevelUrl, z.literal('')]).optional(),
      confirmation,
    })
    .strict(),
  z
    .object({ action: z.literal('backup'), name: z.string().trim().max(80) })
    .strict(),
  z
    .object({ action: z.literal('restore'), id: backupId, confirmation })
    .strict(),
  z
    .object({ action: z.literal('remove-backup'), id: backupId, confirmation })
    .strict(),
  /**
   * Stop, install or update Oxide or Carbon from its release, then start
   * again if it ran. A server runs one plugin framework, never both.
   */
  z
    .object({
      action: z.literal('install-framework'),
      framework: z.enum(rustFrameworkNames),
      confirmation,
    })
    .strict(),
  /**
   * Stop, remove the installed plugin framework and put back the game's own
   * files, then start again if it ran. The plugins, their configs and their
   * data stay in the server folder.
   */
  z.object({ action: z.literal('remove-framework'), confirmation }).strict(),
  /** Download a free plugin from uMod. The file it replaces is kept. */
  z
    .object({ action: z.literal('install-plugin'), name: rustPluginName })
    .strict(),
  /** Put back the file the last install of this plugin replaced. */
  z
    .object({ action: z.literal('rollback-plugin'), name: rustPluginName })
    .strict(),
  z
    .object({
      action: z.literal('remove-plugin'),
      name: rustPluginName,
      confirmation,
    })
    .strict(),
  /**
   * Save the settings file of a plugin. The text must be JSON. The file it
   * replaces is kept.
   */
  z
    .object({
      action: z.literal('save-plugin-config'),
      name: rustPluginName,
      revision,
      text: z.string().max(rustPluginConfigMaxBytes),
    })
    .strict(),
  /** Download every installed plugin from uMod again. */
  z.object({ action: z.literal('update-plugins') }).strict(),
  /**
   * One part of a plugin file that staff uploaded. The panel sends the
   * parts in order. The part at offset 0 starts the file again. The host
   * writes the plugin after the last part, when the size and the SHA-256
   * of the whole file match. The file it replaces is kept.
   */
  z
    .object({
      action: z.literal('upload-plugin'),
      name: rustPluginName,
      offset: z.number().int().min(0).max(rustPluginUploadMaxBytes),
      total: z.number().int().min(1).max(rustPluginUploadMaxBytes),
      sha256: revision,
      data: base64(rustPluginUploadChunkBytes),
    })
    .strict(),
]);
export type RustHostCommand = z.infer<typeof rustHostCommand>;
export type RustHostAction = RustHostCommand['action'];

export const rustHostActions: readonly RustHostAction[] =
  rustHostCommand.options.map((option) => option.shape.action.value);

/** Actions that must repeat the server ID. */
export const rustHostConfirmedActions: ReadonlySet<RustHostAction> = new Set([
  'stop',
  'restart',
  'update',
  'wipe',
  'restore',
  'remove-backup',
  'remove-plugin',
  'install-framework',
  'remove-framework',
]);

/** The permission each host action needs. */
export function rustHostPermission(action: RustHostAction) {
  switch (action) {
    case 'backup':
    case 'restore':
    case 'remove-backup':
      return 'host.backups' as const;
    case 'save-config':
    case 'save-plugin-config':
      return 'configuration.manage' as const;
    case 'update':
    case 'update-plugins':
    case 'install-framework':
    case 'remove-framework':
    case 'install-plugin':
    case 'upload-plugin':
    case 'rollback-plugin':
    case 'remove-plugin':
      return 'host.update' as const;
    case 'wipe':
      return 'host.files' as const;
    default:
      return 'host.control' as const;
  }
}

/** The permission each read needs. */
export function rustHostReadPermission(resource: RustHostResource) {
  if (
    resource === 'config' ||
    resource === 'admins' ||
    resource === 'plugin-config'
  )
    return 'configuration.manage' as const;
  if (resource === 'map') return 'players.view' as const;
  if (resource === 'backups') return 'host.backups' as const;
  return 'host.view' as const;
}

/** The shared status with what only Rust reports. */
export const rustHostStatus = bohemiaHostStatus.extend({
  /** The plugin framework found in the server folder. */
  framework: z.enum(['oxide', 'carbon']).nullable().default(null),
  /** The map seed, when the Agent sets it. A wipe may then change it. */
  seed: z.number().int().nullable().default(null),
  /** The world size, when the Agent sets it. A wipe may then change it. */
  worldSize: z.number().int().nullable().default(null),
  /**
   * The address of the custom map, or null for a procedural map. Absent
   * when the host cannot set one.
   */
  levelUrl: z.string().max(rustLevelUrlMax).nullable().optional(),
  /** When the current map save was first written. */
  wipedAt: z.number().int().nonnegative().nullable().default(null),
});
export type RustHostStatus = z.infer<typeof rustHostStatus>;

export const rustHostPlugins = z.object({
  framework: z.enum(['oxide', 'carbon']).nullable(),
  plugins: z
    .array(
      z.object({
        name: z.string().max(80),
        bytes: z.number().int().nonnegative(),
        modifiedAt: z.number().int().nonnegative(),
        /** A copy from before the last install is kept. */
        previous: z.boolean().default(false),
      }),
    )
    .max(500),
  /** The last update of every plugin on this host, when one ran. */
  updates: z
    .object({ at: z.number().int().nonnegative(), results: pluginUpdates })
    .optional(),
  /** The host takes an uploaded plugin file. An older Agent does not. */
  upload: z.boolean().optional(),
});
export type RustHostPlugins = z.infer<typeof rustHostPlugins>;

/** The settings file of one plugin. `exists` is false for a missing file. */
export const rustHostPluginConfig = z.object({
  name: z.string().max(80),
  exists: z.boolean(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().max(rustPluginConfigMaxBytes),
});
export type RustHostPluginConfig = z.infer<typeof rustHostPluginConfig>;

/** `GET /api/native/host?resource=plugin-search&q=`: plugins of uMod. */
export const rustPluginSearch = z.object({
  plugins: z
    .array(
      z.object({
        name: rustPluginName,
        title: z.string().max(120),
        description: z.string().max(300),
        version: z.string().max(40),
        author: z.string().max(120),
        downloads: z.number().int().nonnegative(),
        /** False for a plugin an install cannot download, such as a paid one. */
        installable: z.boolean().default(true),
        /** The version the game server runs, when its plugin list names it. */
        installed: z.string().max(40).optional(),
      }),
    )
    .max(20),
});
export type RustPluginSearch = z.infer<typeof rustPluginSearch>;

/** The in-game owners and moderators, as the server's `users.cfg` lists them. */
export const rustHostAdmins = z.object({
  admins: z
    .array(
      z.object({
        role: z.enum(['owner', 'moderator']),
        steamId: z.string().regex(/^7656119\d{10}$/),
        name: z.string().max(120),
      }),
    )
    .max(500),
  /**
   * True when the list is the copy WarGuardian keeps, because the game host
   * could not be read. The game host itself never sends it.
   */
  stored: z.boolean().optional(),
});
export type RustHostAdmins = z.infer<typeof rustHostAdmins>;

/**
 * Read `users.cfg`: one `ownerid` or `moderatorid` line per admin, with the
 * Steam64 ID and an optional quoted name. Any other line is left out.
 */
export function parseRustUsers(text: string): RustHostAdmins {
  const admins: RustHostAdmins['admins'] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^\s*(ownerid|moderatorid)\s+(7656119\d{10})(?:\s+"([^"]{0,120})")?/.exec(
        line,
      );
    if (!match || seen.has(match[2]!)) continue;
    seen.add(match[2]!);
    const name = (match[3] ?? '').replace(/\p{Cc}/gu, '');
    admins.push({
      role: match[1] === 'ownerid' ? 'owner' : 'moderator',
      steamId: match[2]!,
      // The panel writes the ID as the name. That is no name to show.
      name: name === match[2] ? '' : name,
    });
  }
  return { admins: admins.slice(0, 500) };
}

/** The ocean border of a map render, in pixels on each side. */
export const rustMapMarginPixels = 500;
/** The largest part of the map image one Agent answer carries. */
export const rustMapChunkBytes = 393_216;
/** The largest map image the panel reads. */
export const rustMapMaxBytes = 24 * 1_048_576;

/** The scale `world.rendermap` takes for a world: about 1600 pixels of land. */
export function rustMapScale(worldSize: number): number {
  return Math.min(1, Math.max(0.1, Math.round(160_000 / worldSize) / 100));
}

/**
 * One part of the terrain image the game server rendered, a PNG. The world
 * fills the image without a border of `margin` pixels on each side.
 * `name` is null when the server has not rendered its map.
 */
export const rustHostMap = z.object({
  name: z.string().max(120).nullable(),
  width: z.number().int().min(0).max(20_000),
  margin: z.number().int().min(0).max(2_000),
  total: z.number().int().min(0).max(rustMapMaxBytes),
  offset: z.number().int().min(0).max(rustMapMaxBytes),
  /** Base64. */
  data: z.string().max(34_000_000),
  modifiedAt: z.number().int().nonnegative(),
});
export type RustHostMap = z.infer<typeof rustHostMap>;

/** The name of a map render in the server folder. */
export const rustMapFileName = /^map_\d{3,5}_\d{1,10}\.png$/;

/** The width of a PNG from its header, or 0 for another file. */
export function pngWidth(head: Uint8Array): number {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length < 24 || signature.some((byte, at) => head[at] !== byte))
    return 0;
  return (
    ((head[16]! << 24) | (head[17]! << 16) | (head[18]! << 8) | head[19]!) >>> 0
  );
}

export const rustHostReadSchemas = {
  status: rustHostStatus,
  config: bohemiaHostConfig,
  logs: bohemiaHostLogs,
  backups: bohemiaHostBackups,
  plugins: rustHostPlugins,
  admins: rustHostAdmins,
  map: rustHostMap,
  'plugin-config': rustHostPluginConfig,
} as const satisfies Record<RustHostResource, z.ZodType>;

/**
 * The relay path of one read. `logs` may name a log file, and
 * `plugin-config` names the plugin.
 */
export function rustHostReadPath(
  resource: RustHostResource,
  log?: string,
  offset = 0,
): string {
  if (resource === 'plugin-config')
    return `${bohemiaHostPaths.prefix}plugin-config?name=${rustPluginName.parse(log)}`;
  if (resource === 'map')
    return `${bohemiaHostPaths.prefix}map?offset=${Math.max(0, Math.trunc(offset))}`;
  if (resource === 'logs' && log !== undefined) {
    bohemiaLogName.parse(log);
    return `${bohemiaHostPaths.prefix}logs?name=${encodeURIComponent(log)}`;
  }
  return `${bohemiaHostPaths.prefix}${resource}`;
}

/**
 * The Agent's answer to a host command, as for every game. An update of
 * every plugin over file access adds what it did with each plugin. A save of
 * plugin settings adds whether the game server confirmed the reload.
 */
export const rustHostReceipt = bohemiaHostReceipt.extend({
  plugins: pluginUpdates.optional(),
  reloaded: z.boolean().optional(),
  /** An upload: whether the file replaced an installed plugin. */
  replaced: z.boolean().optional(),
});
export type RustHostReceipt = z.infer<typeof rustHostReceipt>;
