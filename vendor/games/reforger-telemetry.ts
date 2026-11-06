import { z } from 'zod';
import { reforgerIdentity } from './reforger';

const subject = z
  .object({
    identityId: reforgerIdentity.transform((id) => id.toLowerCase()),
    name: z.string().max(512),
    faction: z.string().max(120).nullable().default(null),
  })
  .strict();
const base = z.object({
  id: z.string().min(1).max(160),
  at: z.number().int().min(1577836800000).max(4102444800000),
});
export const reforgerTelemetryEvent = z.discriminatedUnion('kind', [
  base
    .extend({
      kind: z.literal('player'),
      player: subject,
      activity: z
        .enum([
          'connected',
          'registered',
          'spawned',
          'disconnected',
          'components-disconnected',
          'deleted',
          'role-changed',
          'audit-success',
          'audit-failed',
          'audit-revived',
          'audit-timeout',
        ])
        .optional(),
      pingMs: z.number().int().min(0).max(60000).nullable().default(null),
      platform: z
        .enum(['steam', 'xbox', 'playstation', 'unknown'])
        .default('unknown'),
      steamId: z
        .string()
        .regex(/^7656119\d{10}$/)
        .nullable()
        .default(null),
    })
    .strict()
    .refine(
      (event) => !event.steamId || event.platform === 'steam',
      'A Steam identifier requires the Steam platform.',
    ),
  base
    .extend({
      kind: z.literal('kill'),
      victim: subject,
      killer: subject.nullable(),
      teamKill: z.boolean().nullable().default(null),
      weapon: z.string().max(200).nullable().default(null),
      distanceMeters: z.number().min(0).max(100000).nullable().default(null),
      headshot: z.boolean().nullable().default(null),
    })
    .strict(),
  base
    .extend({
      kind: z.literal('heartbeat'),
      producerVersion: z.string().max(64),
    })
    .strict(),
]);
export const reforgerTelemetryBatch = z
  .object({
    format: z.literal('warguardian.reforger-telemetry'),
    version: z.literal(1),
    provider: z.enum(['enhance-logging', 'warguardian']),
    providerVersion: z.string().min(1).max(120),
    stream: z.string().trim().min(1).max(160),
    events: z.array(reforgerTelemetryEvent).min(1).max(500),
  })
  .strict()
  .refine(
    (batch) =>
      new Set(batch.events.map((event) => event.id)).size ===
      batch.events.length,
    'Duplicate event IDs must be reconciled before importing.',
  );
export type ReforgerTelemetryBatch = z.infer<typeof reforgerTelemetryBatch>;
export const reforgerJournalPage = z.object({
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  nextOffset: z.number().int().nonnegative(),
  gap: z.boolean(),
  batch: reforgerTelemetryBatch.nullable(),
});
export const reforgerTelemetryImport = z
  .object({
    action: z.literal('import-telemetry'),
    batch: reforgerTelemetryBatch,
  })
  .strict();
export const reforgerTelemetryImportState = z
  .object({
    action: z.literal('telemetry-import-state'),
    id: z.string().regex(/^[a-f0-9]{64}$/),
    withdrawn: z.boolean(),
  })
  .strict();
export const reforgerTelemetryReceipt = z.object({
  ok: z.literal(true),
  id: z.string(),
  inserted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});
export const reforgerTelemetrySummary = z.object({
  collection: z
    .object({
      enabled: z.boolean(),
      checkedAt: z.number().nullable(),
      sourceAt: z.number().nullable(),
      error: z.string().nullable(),
      gaps: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  events: z.number().int().nonnegative(),
  kills: z.number().int().nonnegative(),
  players: z.number().int().nonnegative(),
  lastAt: z.number().nullable(),
  imports: z
    .array(
      z.object({
        id: z.string(),
        at: z.number(),
        provider: z.string(),
        providerVersion: z.string(),
        stream: z.string(),
        events: z.number(),
        actorName: z.string(),
        withdrawn: z.boolean().default(false),
      }),
    )
    .max(30),
});
export const reforgerPlayerIntelligence = z.object({
  observations: z
    .array(
      z.object({
        ...reforgerTelemetryEvent.options[0].shape,
        provider: z.string(),
        providerVersion: z.string(),
      }),
    )
    .max(20)
    .default([]),
  enrichment: z
    .object({
      at: z.number(),
      provider: z.string(),
      providerVersion: z.string(),
      faction: z.string().nullable(),
      pingMs: z.number().nullable(),
      platform: z.string(),
      steamId: z.string().nullable(),
    })
    .nullable(),
  combat: z
    .object({
      kills: z.number(),
      deaths: z.number(),
      teamKills: z.number(),
      suicides: z.number(),
      unclassifiedKills: z.number(),
      firstAt: z.number().nullable(),
      lastAt: z.number().nullable(),
    })
    .nullable(),
  recent: z
    .array(
      z.object({
        ...reforgerTelemetryEvent.options[1].shape,
        provider: z.string(),
        providerVersion: z.string(),
      }),
    )
    .max(20),
});

/** Convert documented export data, never execute a source-panel implementation.
 * The Enhance Logging file format prefixes each JSON object with local time;
 * only its explicit systemTimeInt (Unix seconds) establishes event time. */
export function previewReforgerTelemetry(
  text: string,
  stream: string,
): { batch: ReforgerTelemetryBatch; warnings: string[] } {
  if (new TextEncoder().encode(text).length > 1048576)
    throw new Error(
      'Telemetry imports are limited to 1 MiB. Split the source file into bounded batches.',
    );
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const document: unknown = JSON.parse(trimmed);
      if (document && typeof document === 'object' && 'format' in document)
        return {
          batch: reforgerTelemetryBatch.parse(document),
          warnings: [
            'Imported telemetry is supplied by the source server. It is not proof of cheating or verified account ownership.',
          ],
        };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const records: Record<string, unknown>[] = [];
  if (trimmed.startsWith('['))
    records.push(
      ...z
        .array(z.record(z.string(), z.unknown()))
        .max(500)
        .parse(JSON.parse(trimmed)),
    );
  else {
    let offset = 0;
    while (offset < trimmed.length) {
      const start = trimmed.indexOf('{', offset);
      if (start < 0) {
        if (trimmed.slice(offset).trim())
          throw new Error('Source text has an incomplete JSON record.');
        break;
      }
      if (start - offset > 256)
        throw new Error(
          'Unsupported log prefix. Choose Enhance Logging JSON records.',
        );
      let depth = 0,
        quoted = false,
        escaped = false,
        end = -1;
      for (let index = start; index < trimmed.length; index++) {
        const character = trimmed[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') {
          if (++depth > 32)
            throw new Error('JSON nesting exceeds the import limit.');
        } else if (character === '}' && --depth === 0) {
          end = index + 1;
          break;
        }
      }
      if (end < 0)
        throw new Error('Source text has an incomplete JSON record.');
      records.push(
        z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(trimmed.slice(start, end))),
      );
      if (records.length > 500)
        throw new Error('Import up to 500 source records per batch.');
      offset = end;
    }
  }
  if (records.length > 500)
    throw new Error('Import up to 500 source records per batch.');
  const events: ReforgerTelemetryBatch['events'] = [];
  let omitted = 0,
    missingIdentity = 0;
  const activities: Record<
    string,
    NonNullable<z.infer<(typeof reforgerTelemetryEvent.options)[0]>['activity']>
  > = {
    PlayerConnected: 'connected',
    Registered: 'registered',
    PlayerSpawned: 'spawned',
    Disconnected: 'disconnected',
    CompDisconnected: 'components-disconnected',
    PlayerDeleted: 'deleted',
    PlayerRoleChange: 'role-changed',
    AuditSuccess: 'audit-success',
    AuditFailed: 'audit-failed',
    AuditRevived: 'audit-revived',
    AuditTimeouted: 'audit-timeout',
  };
  const person = (record: Record<string, unknown>, prefix: string) => ({
    identityId: record[`${prefix}PlayerBiId`],
    name: record[`${prefix}PlayerName`] ?? '',
    faction: record[`${prefix}PlayerFaction`] ?? null,
  });
  for (const record of records) {
    const activity =
      typeof record.function === 'string' &&
      Object.hasOwn(activities, record.function)
        ? activities[record.function]
        : undefined;
    if (activity) {
      if (!reforgerIdentity.safeParse(record.playerBiId).success) {
        omitted++;
        missingIdentity++;
        continue;
      }
      const scalar = z.union([z.string().max(80), z.number()]);
      const epoch = scalar.parse(record.systemTimeInt);
      const serverTime = scalar.parse(
        record.serverTimeSecondsFloat ?? record.serverTimeSecondsStr ?? '',
      );
      const session = scalar.parse(record.playerId);
      events.push(
        reforgerTelemetryEvent.options[0].parse({
          kind: 'player',
          activity,
          id: `enhance-player:${epoch}:${serverTime}:${activity}:${session}`,
          at: Number(epoch) * 1000,
          player: {
            identityId: record.playerBiId,
            name: record.playerName ?? '',
            faction: record.playerFaction ?? null,
          },
        }),
      );
      continue;
    }
    if (record.function !== 'PlayerKilled') {
      omitted++;
      continue;
    }
    const at = Number(record.systemTimeInt) * 1000;
    if (!Number.isFinite(at))
      throw new Error(
        'A kill record has no Unix timestamp. Local time is ambiguous and is not guessed.',
      );
    const flag = record.IsTeamKill;
    if (
      !['0', '1', 'true', 'false', true, false, undefined].includes(
        flag as string | boolean | undefined,
      )
    )
      throw new Error('A kill record has an unknown team-kill value.');
    const killerId = record.KillerPlayerBiId;
    const scalar = z.union([z.string().max(80), z.number()]);
    const epoch = scalar.parse(record.systemTimeInt),
      serverTime = scalar.parse(
        record.serverTimeSecondsFloat ?? record.serverTimeSecondsStr ?? '',
      ),
      victimSession = scalar.parse(record.VictimPlayerID),
      killerSession = scalar.parse(record.KillerPlayerID);
    const event = reforgerTelemetryEvent.options[1].parse({
      kind: 'kill',
      id: `enhance:${epoch}:${serverTime}:${victimSession}:${killerSession}`,
      at,
      victim: person(record, 'Victim'),
      killer: reforgerIdentity.safeParse(killerId).success
        ? person(record, 'Killer')
        : null,
      teamKill:
        flag === undefined
          ? null
          : flag === true || flag === '1' || flag === 'true',
      weapon:
        record.KillerPlayerWeaponName ?? record.KillerPlayerWeaponType ?? null,
    });
    if (!event.killer && Number(record.KillerPlayerID) > 0)
      throw new Error(
        'A player killer has no valid Bohemia identity. Repair the source record. Names are not substituted.',
      );
    events.push(event);
  }
  return {
    batch: reforgerTelemetryBatch.parse({
      format: 'warguardian.reforger-telemetry',
      version: 1,
      provider: 'enhance-logging',
      providerVersion: 'JSON game events / 2.2 schema',
      stream,
      events,
    }),
    warnings: [
      `${omitted} source records omitted; ${missingIdentity} lacked a native identity. Import one authoritative file stream; ALL and PLAYERS files can overlap.`,
      'Only explicit Bohemia IDs and Unix timestamps are accepted. IPs, machine names and client-reported extracts are excluded. This source does not supply verified Steam ownership, measured ping or headshots.',
      'Imported history represents the supplied records, not complete lifetime coverage. Provider compatibility on the current game build must be qualified separately.',
    ],
  };
}
