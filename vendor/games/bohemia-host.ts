import { z } from 'zod';
import {
  bohemiaMod,
  bohemiaModList,
  steamWorkshopId,
} from './bohemia-workshop';

/**
 * The game host contract of Arma 3 and DayZ between the panel and the
 * WarGuardian Agent. The panel sends `GET /native/v1/host/<resource>` reads
 * and `POST /native/v1/host/command` with one `bohemiaHostCommand`. The Agent
 * builds every process argument and file path itself. It runs no shell and
 * accepts no raw command, path or argument.
 */

export const bohemiaHostPaths = Object.freeze({
  prefix: '/native/v1/host/',
  command: '/native/v1/host/command',
});

export const bohemiaHostResources = [
  'status',
  'config',
  'logs',
  'backups',
  'mods',
] as const;
export type BohemiaHostResource = (typeof bohemiaHostResources)[number];

/** The largest config file the editor reads or writes. It fits one relay command. */
export const bohemiaConfigMaxBytes = 49_152;
/** The largest log page. */
export const bohemiaLogPageMax = 131_072;
/** The placeholder that keeps a stored password unchanged. */
export const bohemiaSecretPlaceholder = '[unchanged secret]';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const confirmation = z.string().trim().min(1).max(120);
const backupId = z.string().regex(/^[a-z0-9-]{1,80}$/);
export const bohemiaLogName = z
  .string()
  .regex(/^[A-Za-z0-9_. -]{1,160}\.(?:rpt|log|adm|ADM|RPT|LOG)$/);

export const bohemiaHostCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }).strict(),
  z.object({ action: z.literal('stop'), confirmation }).strict(),
  z.object({ action: z.literal('restart'), confirmation }).strict(),
  z
    .object({
      action: z.literal('save-config'),
      revision,
      text: z.string().max(bohemiaConfigMaxBytes),
    })
    .strict(),
  z
    .object({
      action: z.literal('save-mods'),
      revision,
      mods: bohemiaModList,
    })
    .strict(),
  /** Download or update the listed mods with SteamCMD and refresh keys. */
  z
    .object({
      action: z.literal('install-mods'),
      ids: z.array(steamWorkshopId).min(1).max(300),
    })
    .strict(),
  /** Link the saved list into the server folder, sync keys, then restart. */
  z
    .object({
      action: z.literal('apply-mods'),
      revision,
      restart: z.boolean(),
    })
    .strict(),
  /** Link the list before the last apply again, then optionally restart. */
  z
    .object({
      action: z.literal('revert-mods'),
      restart: z.boolean(),
      confirmation,
    })
    .strict(),
  z.object({ action: z.literal('check-mod-updates') }).strict(),
  z
    .object({ action: z.literal('backup'), name: z.string().trim().max(80) })
    .strict(),
  z
    .object({ action: z.literal('restore'), id: backupId, confirmation })
    .strict(),
  z
    .object({ action: z.literal('remove-backup'), id: backupId, confirmation })
    .strict(),
]);
export type BohemiaHostCommand = z.infer<typeof bohemiaHostCommand>;
export type BohemiaHostAction = BohemiaHostCommand['action'];

/** The permission each host action needs. Reforger uses the same names. */
export function bohemiaHostPermission(action: BohemiaHostAction) {
  if (action === 'backup' || action === 'restore' || action === 'remove-backup')
    return 'host.backups' as const;
  if (
    action === 'save-config' ||
    action === 'save-mods' ||
    action === 'check-mod-updates'
  )
    return 'configuration.manage' as const;
  if (action === 'install-mods') return 'host.update' as const;
  return 'host.control' as const;
}

/** The permission each read needs. */
export function bohemiaHostReadPermission(resource: BohemiaHostResource) {
  if (resource === 'config' || resource === 'mods')
    return 'configuration.manage' as const;
  if (resource === 'backups') return 'host.backups' as const;
  return 'host.view' as const;
}

/** Actions that change the host. A missing reply leaves them unconfirmed. */
export const bohemiaHostWriteActions: ReadonlySet<BohemiaHostAction> = new Set(
  bohemiaHostCommand.options.map((option) => option.shape.action.value),
);

export const bohemiaJob = z.object({
  id: z.string().max(80),
  action: z.string().max(40),
  state: z.enum(['running', 'succeeded', 'failed', 'unknown']),
  message: z.string().max(400),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
});
export type BohemiaJob = z.infer<typeof bohemiaJob>;

export const bohemiaHostStatus = z.object({
  configured: z.boolean(),
  running: z.boolean(),
  /** Started by this Agent, so it may stop it. */
  managed: z.boolean(),
  pid: z.number().int().positive().nullable(),
  startedAt: z.number().int().nonnegative().nullable(),
  memoryBytes: z.number().nonnegative().nullable(),
  loadAverage: z.number().nonnegative().nullable(),
  freeDiskBytes: z.number().nonnegative().nullable(),
  steamcmd: z.boolean(),
  job: bohemiaJob.nullable(),
  /** The mod list the running process was started with differs from the saved one. */
  restartPending: z.boolean(),
  platform: z.enum(['linux', 'win32']),
});
export type BohemiaHostStatus = z.infer<typeof bohemiaHostStatus>;

export const bohemiaHostConfig = z.object({
  revision,
  file: z.string().max(160),
  text: z.string().max(bohemiaConfigMaxBytes),
});
export type BohemiaHostConfig = z.infer<typeof bohemiaHostConfig>;

export const bohemiaLogFile = z.object({
  name: bohemiaLogName,
  kind: z.enum(['rpt', 'adm', 'log']),
  bytes: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
});
export const bohemiaHostLogs = z.object({
  files: z.array(bohemiaLogFile).max(50),
  /** The file read, or null when there is none. */
  name: bohemiaLogName.nullable(),
  text: z.string().max(bohemiaLogPageMax * 2),
  truncated: z.boolean(),
});
export type BohemiaHostLogs = z.infer<typeof bohemiaHostLogs>;

export const bohemiaBackup = z.object({
  id: backupId,
  name: z.string().max(80),
  createdAt: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});
export const bohemiaHostBackups = z.object({
  backups: z.array(bohemiaBackup).max(50),
});
export type BohemiaHostBackups = z.infer<typeof bohemiaHostBackups>;

export const bohemiaInstalledMod = z.object({
  id: steamWorkshopId,
  /** SteamCMD's `timeupdated`, in Unix seconds. */
  installedAt: z.number().int().nonnegative().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  keys: z.array(z.string().max(160)).max(50),
  /** The `name` of `meta.cpp` or `mod.cpp`, when present. */
  name: z.string().max(160).nullable(),
});
export type BohemiaInstalledMod = z.infer<typeof bohemiaInstalledMod>;

export const bohemiaHostMods = z.object({
  revision,
  mods: z.array(bohemiaMod).max(300),
  installed: z.array(bohemiaInstalledMod).max(600),
  /** The list the running process was started with, or null. */
  launched: z.array(bohemiaMod).max(300).nullable(),
  /** The list before the last apply. An earlier Agent sends none. */
  previous: z.array(bohemiaMod).max(300).nullable().default(null),
  /** Keys this Agent copied into the server `keys` folder. */
  keys: z.array(z.string().max(160)).max(600),
  checkedAt: z.number().int().nonnegative().nullable(),
});
export type BohemiaHostMods = z.infer<typeof bohemiaHostMods>;

export const bohemiaHostReceipt = z.object({
  ok: z.boolean(),
  message: z.string().max(400),
  job: bohemiaJob.nullable().default(null),
});
export type BohemiaHostReceipt = z.infer<typeof bohemiaHostReceipt>;

export const bohemiaHostReadSchemas = {
  status: bohemiaHostStatus,
  config: bohemiaHostConfig,
  logs: bohemiaHostLogs,
  backups: bohemiaHostBackups,
  mods: bohemiaHostMods,
} as const satisfies Record<BohemiaHostResource, z.ZodType>;

/** The relay path of one read. Only `logs` takes a query: the file name. */
export function bohemiaHostReadPath(
  resource: BohemiaHostResource,
  log?: string,
): string {
  if (resource === 'logs' && log !== undefined) {
    bohemiaLogName.parse(log);
    return `${bohemiaHostPaths.prefix}logs?name=${encodeURIComponent(log)}`;
  }
  return `${bohemiaHostPaths.prefix}${resource}`;
}

const readPath = new RegExp(
  `^/native/v1/host/(?:status|config|backups|mods|logs(?:\\?name=[A-Za-z0-9_.%-]{1,480})?)$`,
);

/** Whether a relay command is a host read or the host command route. */
export function bohemiaHostRelayAllowed(method: string, path: string) {
  if (method === 'POST') return path === bohemiaHostPaths.command;
  return method === 'GET' && readPath.test(path);
}

export { bohemiaMod };
