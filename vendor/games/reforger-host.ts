import { z } from 'zod';
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.includes(':') &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..'),
    'Use a path inside this server profile.',
  );
export const reforgerMod = z
  .object({
    modId: z
      .string()
      .regex(/^[a-f0-9]{16}$/i)
      .transform((value) => value.toUpperCase()),
    name: z.string().max(120).optional(),
    version: z.string().max(64).optional(),
    required: z.boolean().optional(),
  })
  .strict();
export const reforgerModpack = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    name: z.string().trim().min(1).max(120),
    mods: z
      .array(
        reforgerMod
          .extend({
            enabled: z.boolean().optional(),
            origin: z.enum(['selected', 'dependency']).optional(),
          })
          .strict(),
      )
      .max(300),
  })
  .strict()
  .refine(
    (pack) =>
      new Set(pack.mods.map((mod) => mod.modId)).size === pack.mods.length,
    'A modpack cannot contain duplicate Workshop IDs.',
  );
export const reforgerScenarioId = z
  .string()
  .regex(/^\{[A-Fa-f0-9]{16}\}[^\r\n"\\]{1,240}\.conf$/);
export const reforgerScenarioPreset = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().trim().min(1).max(80),
  scenarioId: reforgerScenarioId,
  modpackId: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .nullable()
    .default(null),
  maxPlayers: z.number().int().min(1).max(128).nullable().default(null),
});
/** The WarGuardian Agent capability that loads a modpack's cached mods in a scenario scan. */
export const reforgerScenarioAddonsCapability = 'scenario-addons';
const modpackKey = z.string().regex(/^[a-z0-9-]{1,64}$/);
/**
 * Where a scanned scenario comes from. Scans by an earlier WarGuardian Agent
 * have no source, and those scenarios read as found on the host.
 */
export const reforgerScenarioSource = z
  .object({
    kind: z.enum(['official', 'host', 'mod']),
    modId: z
      .string()
      .regex(/^[A-F0-9]{16}$/)
      .optional(),
    modName: z.string().max(160).optional(),
  })
  .catch({ kind: 'host' as const });
export const reforgerScenarios = z.object({
  current: z.string().nullable(),
  scenarios: z.array(reforgerScenarioPreset).max(30),
  rotation: z.object({
    order: z.array(z.string()).max(30),
    next: z.number().int().nonnegative(),
  }),
  discovered: z
    .object({
      at: z.number(),
      items: z
        .array(
          z.object({
            scenarioId: reforgerScenarioId,
            name: z.string().max(160).nullable(),
            source: reforgerScenarioSource,
          }),
        )
        .max(500),
      error: z.string().nullable(),
      /** The modpack whose cached mods the scan loaded. */
      modpackId: modpackKey.nullable().catch(null),
    })
    .nullable()
    .default(null),
});
const saveFolder = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,159}$/);
export const reforgerSavePoint = z.object({
  folder: saveFolder,
  id: z.string().max(64).nullable(),
  number: z.number().nullable(),
  savedAt: z.number().nullable(),
  playtimeSeconds: z.number().nullable(),
  gameVersion: z.string().max(64).nullable(),
  addons: z.number().nullable(),
  bytes: z.number(),
});
export const reforgerSaves = z.object({
  root: z.string().nullable(),
  scenarios: z
    .array(
      z.object({
        folder: saveFolder,
        scenarioGuid: z.string().nullable(),
        playthroughs: z
          .array(
            z.object({
              folder: saveFolder,
              savePoints: z.array(reforgerSavePoint).max(200),
            }),
          )
          .max(50),
      }),
    )
    .max(50),
  archived: z
    .array(
      z.object({
        id: z.uuid(),
        scenario: saveFolder,
        playthrough: saveFolder,
        at: z.number(),
        bytes: z.number(),
      }),
    )
    .max(100),
  nextLaunch: z.object({
    mode: z.enum(['default', 'save', 'fresh']),
    saveId: z.string().max(64).nullable(),
  }),
});
export const reforgerHostInstances = z.object({
  installation: z.string().max(200),
  instances: z
    .array(
      z.object({
        serverId: z.string().max(64),
        serverName: z.string().max(200),
        active: z.boolean(),
        running: z.boolean(),
        ports: z
          .object({
            game: z.number(),
            query: z.number().nullable(),
            rcon: z.number().nullable(),
          })
          .nullable(),
        updatedAt: z.number(),
      }),
    )
    .max(64),
});
export const reforgerHostCommand = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('quarantine-mod-cache'),
      modId: z.string().regex(/^[A-F0-9]{16}$/),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      configRevision: z.string().regex(/^[a-f0-9]{64}$/),
      allowReferenced: z.boolean().default(false),
      confirmation: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal('restore-mod-cache'),
      id: z.uuid(),
      confirmation: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal('begin-backup-import'),
      id: z.uuid(),
      name: z.string().min(1).max(120),
      bytes: z.number().int().min(1).max(536870912),
      manifest: z
        .object({
          version: z.literal(1),
          instanceName: z.string().max(120).optional(),
          createdAt: z.string().max(100).optional(),
        })
        .loose(),
    })
    .strict(),
  z
    .object({
      action: z.literal('remove-quarantined-mod-cache'),
      id: z.uuid(),
      confirmation: z.string().min(1).max(120),
    })
    .strict(),
  z
    .object({
      action: z.literal('append-backup-import'),
      id: z.uuid(),
      offset: z.number().int().min(0).max(536870912),
      data: z
        .string()
        .min(4)
        .max(43692)
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        ),
    })
    .strict(),
  z
    .object({ action: z.literal('finish-backup-import'), id: z.uuid() })
    .strict(),
  z
    .object({ action: z.literal('cancel-backup-import'), id: z.uuid() })
    .strict(),
  z.object({ action: z.literal('start') }).strict(),
  z
    .object({
      action: z.literal('restart-instance'),
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('stop'),
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('adopt'),
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('save-config'),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      config: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      action: z.literal('save-modpack'),
      modpack: reforgerModpack,
      revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('import-modpacks'),
      source: z.string().min(1).max(120),
      modpacks: z.array(reforgerModpack).min(1).max(20),
      revisions: z.record(
        z.string(),
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      ),
    })
    .strict()
    .refine(
      (value) =>
        new Set(value.modpacks.map((pack) => pack.id)).size ===
        value.modpacks.length,
      'Import pack IDs must be unique.',
    ),
  z
    .object({
      action: z.literal('remove-modpack'),
      id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal('resolve-modpack'),
      id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      communityMetadataConsent: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('apply-modpack'),
      id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      packRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      mode: z.enum(['replace', 'append']),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal('save-scenario'),
      scenario: reforgerScenarioPreset,
    })
    .strict(),
  z
    .object({
      action: z.literal('remove-scenario'),
      id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal('save-rotation'),
      order: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(30),
    })
    .strict(),
  z
    .object({
      action: z.literal('switch-scenario'),
      id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('rotate-scenario'),
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('list-scenarios'),
      // Sent only to an agent with `scenario-addons`. An earlier agent
      // refuses the field.
      modpackId: modpackKey.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('set-next-save'),
      mode: z.enum(['default', 'save', 'fresh']),
      saveId: z.uuid().nullable().default(null),
    })
    .strict(),
  z
    .object({
      action: z.literal('archive-playthrough'),
      scenario: saveFolder,
      playthrough: saveFolder,
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('restore-playthrough'),
      id: z.uuid(),
    })
    .strict(),
  z.object({ action: z.literal('backup') }).strict(),
  z
    .object({
      action: z.literal('restore'),
      id: z.uuid(),
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('remove-backup'),
      id: z.uuid(),
      confirmation: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('write-file'),
      path: relativePath,
      revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      text: z.string().max(32768),
    })
    .strict(),
  z.object({ action: z.literal('mkdir'), path: relativePath }).strict(),
  z
    .object({
      action: z.literal('rename-file'),
      path: relativePath,
      destination: relativePath,
    })
    .strict(),
  z
    .object({
      action: z.literal('remove-file'),
      path: relativePath,
      confirmation: relativePath,
    })
    .strict(),
  z
    .object({ action: z.literal('auto-restart'), enabled: z.boolean() })
    .strict(),
  z
    .object({
      action: z.literal('review-job'),
      confirmation: z.string().min(1).max(200),
    })
    .strict(),
  z.object({ action: z.literal('check-mod-updates') }).strict(),
]);
export function reforgerHostPermission(
  action: z.infer<typeof reforgerHostCommand>['action'],
) {
  if (action === 'update') return 'host.update' as const;
  if (action === 'review-job') return 'host.manage' as const;
  if (
    action === 'quarantine-mod-cache' ||
    action === 'restore-mod-cache' ||
    action === 'remove-quarantined-mod-cache'
  )
    return 'host.files' as const;
  if (
    action === 'backup' ||
    action === 'restore' ||
    action === 'remove-backup' ||
    action === 'archive-playthrough' ||
    action === 'restore-playthrough' ||
    action.endsWith('-backup-import')
  )
    return 'host.backups' as const;
  if (['write-file', 'mkdir', 'rename-file', 'remove-file'].includes(action))
    return 'host.files' as const;
  if (
    [
      'save-config',
      'save-modpack',
      'import-modpacks',
      'remove-modpack',
      'apply-modpack',
      'resolve-modpack',
      'check-mod-updates',
      'save-scenario',
      'remove-scenario',
      'save-rotation',
      'list-scenarios',
    ].includes(action)
  )
    return 'configuration.manage' as const;
  return 'host.control' as const;
}
export const reforgerHostRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enroll') }).strict(),
  z.object({ action: z.literal('disconnect') }).strict(),
  z
    .object({ action: z.literal('command'), command: reforgerHostCommand })
    .strict(),
]);
export const reforgerHostStatus = z.object({
  connected: z.boolean(),
  enrolled: z.boolean(),
  lastSeenAt: z.number().nullable(),
  host: z
    .object({
      running: z.boolean(),
      managed: z.boolean(),
      pid: z.number().nullable(),
      job: z
        .object({
          id: z.string(),
          action: z.string(),
          state: z.string(),
          message: z.string(),
        })
        .nullable(),
      autoRestart: z.boolean(),
      memoryBytes: z.number().nullable(),
      loadAverage: z.number().nullable(),
      freeDiskBytes: z.number().nullable(),
      capabilities: z.array(z.string()),
      message: z.string(),
    })
    .nullable(),
});
export const reforgerHostConfig = z.object({
  revision: z.string(),
  config: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
});
export const reforgerHostFiles = z.object({
  path: z.string(),
  entries: z
    .array(
      z.object({
        name: z.string(),
        directory: z.boolean(),
        bytes: z.number(),
        readable: z.boolean(),
      }),
    )
    .max(1000),
});
export const reforgerHostFile = z.object({
  path: z.string(),
  text: z.string(),
  revision: z.string(),
  redacted: z.boolean().default(false),
});
export const reforgerHostLogs = z.object({
  text: z.string(),
  truncated: z.boolean(),
});
/** The WarGuardian Agent capability that serves log pages and chunks. */
export const reforgerLogsCapability = 'logs-tail';
/** The largest raw byte range of one log page or download chunk. */
export const reforgerLogPageMax = 262_144;
/** A download reads at most the last 32 MiB of a log file. */
export const reforgerLogDownloadMax = 33_554_432;
export const reforgerLogSource = z.enum([
  'console',
  'script',
  'error',
  'crash',
]);
export const reforgerLogSessionName = z
  .string()
  .regex(/^logs_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
export const reforgerLogSession = z.union([
  z.literal('current'),
  reforgerLogSessionName,
]);
export const reforgerLogGeneration = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const logOffset = z.number().int().nonnegative();
/** One redacted page of whole log lines after a byte cursor. */
export const reforgerLogPage = z.object({
  gen: reforgerLogGeneration,
  session: reforgerLogSession,
  sessions: z
    .array(
      z.object({
        name: reforgerLogSessionName,
        at: z.number().int().nullable(),
        sources: z.array(reforgerLogSource).max(4),
      }),
    )
    .max(50),
  size: logOffset,
  from: logOffset,
  to: logOffset,
  text: z.string().max(1_000_000),
  rotated: z.boolean(),
  truncatedBefore: z.boolean(),
});
/** One redacted download chunk of whole log lines. `next` is null at the end. */
export const reforgerLogChunk = z.object({
  offset: logOffset,
  size: logOffset,
  text: z.string().max(1_000_000),
  next: logOffset.nullable(),
  gen: reforgerLogGeneration.optional(),
});
export const reforgerHostBackups = z.object({
  backups: z
    .array(
      z.object({
        id: z.uuid(),
        at: z.number(),
        bytes: z.number(),
        files: z.number(),
        sha256: z.string(),
        source: z.literal('reforger-host-v1').optional(),
      }),
    )
    .max(50),
});
export const reforgerBackupImportStatus = z.object({
  upload: z
    .object({
      id: z.uuid(),
      name: z.string(),
      bytes: z.number().int(),
      received: z.number().int(),
      at: z.number(),
    })
    .nullable(),
  draft: z
    .object({
      backupId: z.uuid(),
      source: z.literal('reforger-host-v1'),
      config: z.record(z.string(), z.unknown()),
      excluded: z.array(z.string()),
      omitted: z.number().int(),
    })
    .nullable(),
});
export const reforgerModpackReport = z.object({
  id: z.string(),
  at: z.number(),
  provider: z.literal('reforgermods.net'),
  mods: z.number().int(),
  warnings: z.array(z.string()).max(300),
  edges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        version: z.string().optional(),
      }),
    )
    .max(3000)
    .default([]),
  versions: z
    .array(
      z.object({
        modId: z.string(),
        selected: z.string(),
        latest: z.string(),
        gameVersion: z.string().optional(),
      }),
    )
    .max(300)
    .default([]),
});
export const reforgerPackRevision = z.object({
  revision: z.string(),
  at: z.number(),
  pack: reforgerModpack,
});
export const reforgerQuarantinedMod = z.object({
  id: z.uuid(),
  modId: z.string().regex(/^[A-F0-9]{16}$/),
  folder: z.string().min(1).max(240),
  name: z.string().max(160),
  version: z.string().max(64).nullable(),
  at: z.number(),
  removalPending: z.boolean().default(false),
});
export const reforgerModCache = z.object({
  at: z.number(),
  scope: z.literal('profile/addons'),
  configRevision: z.string(),
  launchConfiguration: z.enum([
    'stopped',
    'unchanged',
    'changed',
    'unrecorded',
  ]),
  mods: z
    .array(
      z.object({
        modId: z.string().regex(/^[A-F0-9]{16}$/),
        folder: z.string().max(240),
        name: z.string().max(160),
        version: z.string().max(64).nullable(),
        requestedVersion: z.string().max(64).nullable(),
        configured: z.boolean(),
        required: z.boolean(),
        bytes: z.number().nonnegative(),
        status: z.enum(['cached', 'incomplete', 'conflict', 'unavailable']),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        dependencies: z.array(z.string()).max(300),
        references: z.array(z.string()).max(51),
        referenceCount: z.number().int().nonnegative(),
        problems: z.array(z.string()).max(12),
      }),
    )
    .max(600),
  problems: z.array(z.string()).max(30),
  quarantined: z.array(reforgerQuarantinedMod).max(20),
});
export const reforgerHostModpacks = z.object({
  modpacks: z.array(reforgerModpack).max(100),
  reports: z.array(reforgerModpackReport).max(100).default([]),
  history: z.array(reforgerPackRevision).max(50).default([]),
  revisions: z.record(z.string(), z.string()).default({}),
});
export const reforgerServerSearch = z.object({
  provider: z.literal('reforgermods.net'),
  fetchedAt: z.number(),
  servers: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string().max(200),
        scenarioName: z.string().max(200).nullable(),
        gameVersion: z.string().max(64).nullable(),
        players: z.number().int().nonnegative().nullable(),
        maxPlayers: z.number().int().nonnegative().nullable(),
        modCount: z.number().int().nonnegative().nullable(),
        region: z.string().max(64).nullable(),
        online: z.boolean().nullable(),
      }),
    )
    .max(25),
});
export const reforgerServerMods = z.object({
  provider: z.literal('reforgermods.net'),
  fetchedAt: z.number(),
  serverId: z.uuid(),
  mods: z
    .array(
      z.object({
        modId: z.string().regex(/^[A-F0-9]{16}$/),
        name: z.string().max(160),
        version: z.string().max(64).nullable(),
      }),
    )
    .max(300),
  count: z.number().int().nonnegative(),
});
export const reforgerWorkshopSearch = z.object({
  provider: z.literal('reforgermods.net'),
  fetchedAt: z.number().nullable(),
  page: z.number().int().positive().default(1),
  totalPages: z.number().int().nonnegative().nullable().default(null),
  mods: z
    .array(
      z.object({
        id: z.string().regex(/^[a-f0-9]{16}$/i),
        name: z.string().max(160),
        version: z.string().max(64),
        gameVersion: z.string().max(64).optional(),
        size: z.number().nonnegative().optional(),
      }),
    )
    .max(16),
});
export const reforgerWorkshopVersion = z.object({
  version: z.string().max(64),
  gameVersion: z.string().max(64).optional(),
  published: z.boolean(),
  approved: z.boolean(),
  size: z.number().nonnegative().optional(),
});
export const reforgerWorkshopDetail = z.object({
  provider: z.literal('reforgermods.net'),
  fetchedAt: z.number(),
  mod: z.object({
    id: z.string().regex(/^[a-f0-9]{16}$/i),
    name: z.string().max(160),
    version: z.string().max(64),
    gameVersion: z.string().max(64).optional(),
    author: z.string().max(300).optional(),
    summary: z.string().max(10000).optional(),
    private: z.boolean(),
    obsolete: z.boolean(),
    size: z.number().nonnegative().optional(),
    dependencies: z
      .array(
        z.object({
          id: z.string(),
          name: z.string().optional(),
          version: z.string().optional(),
        }),
      )
      .max(300),
    dependencyCount: z.number().int().nonnegative(),
  }),
  versions: z.array(reforgerWorkshopVersion).max(300),
});
export const reforgerHostReceipt = z.object({
  ok: z.literal(true),
  message: z.string(),
  jobId: z.string().optional(),
});
export const reforgerStatsSample = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number(),
  fps: z.number(),
  frameAvgMs: z.number().nullable(),
  frameMinMs: z.number().nullable(),
  frameMaxMs: z.number().nullable(),
  memoryKb: z.number().nullable(),
  players: z.number().nullable(),
  ai: z.number().nullable(),
  aiCharacters: z.number().nullable(),
  vehicles: z.number().nullable(),
});
export const reforgerLaunchMod = z.object({
  modId: z.string().regex(/^[A-F0-9]{16}$/),
  name: z.string().max(120).optional(),
  version: z.string().max(64).optional(),
});
export const reforgerLifecycleEvent = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number(),
  kind: z.enum([
    'started',
    'stopped',
    'exited',
    'crashed',
    'hang',
    'restart-scheduled',
    'restart-limit',
    'adopted',
  ]),
  pid: z.number().int().nullable().default(null),
  code: z.number().int().nullable().default(null),
  signal: z.string().max(32).nullable().default(null),
  uptimeSeconds: z.number().nullable().default(null),
  configRevision: z.string().max(64).nullable().default(null),
  logStats: z.boolean().nullable().default(null),
  mods: z.array(reforgerLaunchMod).max(300).nullable().default(null),
  message: z.string().max(500),
});
export const reforgerGameEvent = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number(),
  kind: z.enum([
    'vote-started',
    'vote-succeeded',
    'vote-ended',
    'round-started',
    'round-ended',
    'player-link',
    'player-left',
    'kill',
    'base-captured',
    'admin-action',
  ]),
  data: z.record(
    z.string().max(40),
    z.union([z.string().max(160), z.number(), z.boolean(), z.null()]),
  ),
});
export const reforgerResourceSample = z.object({
  seq: z.number().int().nonnegative(),
  at: z.number(),
  cpuPercent: z.number().min(0).max(100).nullable(),
  memoryUsedBytes: z.number().nonnegative().nullable(),
  memoryTotalBytes: z.number().nonnegative().nullable(),
  gameCpuPercent: z.number().min(0).max(100).nullable(),
  gameMemoryBytes: z.number().nonnegative().nullable(),
  loadAverage: z.number().nullable(),
  cores: z.number().int().nonnegative(),
  disks: z
    .array(
      z.object({
        label: z.string().max(40),
        freeBytes: z.number().nonnegative(),
        totalBytes: z.number().nonnegative(),
      }),
    )
    .max(5),
});
export const reforgerHostStability = z.object({
  generation: z.string().max(64),
  logStatsMs: z.number().int().nonnegative(),
  running: z
    .object({
      launchedAt: z.number().nullable(),
      logStats: z.boolean().nullable(),
    })
    .nullable(),
  performance: z.array(reforgerStatsSample).max(500),
  events: z.array(reforgerLifecycleEvent).max(200),
  perfSeq: z.number().int().nonnegative(),
  eventSeq: z.number().int().nonnegative(),
  gameEvents: z.array(reforgerGameEvent).max(500).default([]),
  gameSeq: z.number().int().nonnegative().default(0),
  resources: z.array(reforgerResourceSample).max(500).default([]),
  resourceSeq: z.number().int().nonnegative().default(0),
});
export const reforgerModUpdateEntry = z.object({
  modId: z.string().regex(/^[A-F0-9]{16}$/),
  name: z.string().max(160).nullable(),
  configured: z.boolean(),
  packs: z.array(z.string().max(120)).max(50),
  pinned: z.string().max(64).nullable(),
  cached: z.string().max(64).nullable(),
  latest: z.string().max(64).nullable(),
  gameVersion: z.string().max(64).nullable(),
  state: z.enum([
    'current',
    'update-available',
    'downloads-on-start',
    'delisted',
    'private',
    'obsolete',
    'unavailable',
  ]),
  newDependencies: z
    .array(z.object({ id: z.string(), name: z.string().nullable() }))
    .max(100),
  message: z.string().max(300).nullable(),
});
export const reforgerModUpdates = z.object({
  checkedAt: z.number().nullable(),
  running: z.boolean(),
  startedAt: z.number().nullable(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
  error: z.string().max(500).nullable(),
  nextAutomaticAt: z.number().nullable(),
  mods: z.array(reforgerModUpdateEntry).max(300),
});
