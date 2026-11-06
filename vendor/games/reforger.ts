import { z } from 'zod';
import { banCategorySchema } from '../contracts/ban-category';
import { reforgerQueryInfo } from './reforger-query';

// Engine identities are opaque UUID-shaped values, not necessarily RFC versioned UUIDs.
export const reforgerIdentity = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
export const reforgerPlayer = z.object({
  playerId: z.number().int().nonnegative(),
  identityId: reforgerIdentity,
  name: z.string().max(512),
});
export const reforgerObservation = z.object({
  gameId: z.literal('arma-reforger'),
  observedAt: z.number().nonnegative(),
  players: z.array(reforgerPlayer).max(1000),
});
export type ReforgerObservation = z.infer<typeof reforgerObservation>;
export const reforgerBanImportSource = z
  .object({
    format: z.enum([
      'warguardian-native-v1',
      'warguardian-native-legacy',
      'reforger-manager-rcon',
    ]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    row: z.number().int().min(0).max(9999),
  })
  .strict();
export const reforgerCommand = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('kick'),
      id: reforgerIdentity,
      playerId: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('ban'),
      id: reforgerIdentity,
      durationSeconds: z.number().int().min(0).max(31536000),
      expectAbsent: z.literal(true).optional(),
      importSource: reforgerBanImportSource.optional(),
      // Request only: the category goes to the WarGuardian metadata, not the game.
      category: banCategorySchema.optional(),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[^\r\n"\\;#@]+$/)
        .refine((value) => !value.includes('\0')),
    })
    .strict()
    .refine(
      (command) => !command.importSource || command.expectAbsent === true,
      'Imported bans must retain existing native bans.',
    ),
  z.object({ action: z.literal('unban'), id: reforgerIdentity }).strict(),
  z
    .object({
      action: z.literal('restart'),
      reason: z.string().trim().min(1).max(200),
      confirmation: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal('shutdown'),
      reason: z.string().trim().min(1).max(200),
      confirmation: z.string().trim().min(1).max(200),
    })
    .strict(),
]);
export type ReforgerCommand = z.infer<typeof reforgerCommand>;
export function reforgerCommandPermission(command: ReforgerCommand) {
  return command.action === 'kick'
    ? ('players.kick' as const)
    : command.action === 'ban'
      ? ('bans.add' as const)
      : command.action === 'unban'
        ? ('bans.remove' as const)
        : command.action === 'restart'
          ? ('server.restartMatch' as const)
          : ('server.shutdown' as const);
}
/**
 * The community's own Steam link of a native ban: `own` is confirmed
 * by the community's servers and can be shared, `unconfirmed` is a single or
 * older-agent observation, `conflict` links more than one Steam ID.
 */
export const reforgerBanLink = z.enum(['own', 'unconfirmed', 'conflict']);
export type ReforgerBanLink = z.infer<typeof reforgerBanLink>;
export const reforgerBan = z.object({
  identityId: reforgerIdentity,
  name: z.string().max(512).nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  // Page and search replies add the linked Steam ID, its link and the
  // recorded category. Older replies and the whole list have none.
  steamId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable()
    .optional(),
  link: reforgerBanLink.nullable().optional(),
  category: banCategorySchema.optional(),
});
export const reforgerStatus = z.object({
  state: z.enum(['online', 'stale', 'offline', 'waiting']),
  snapshot: reforgerObservation.nullable(),
  error: z.string().nullable(),
  permission: z.enum(['monitor', 'admin']),
  query: reforgerQueryInfo.nullable().default(null),
  queryError: z.string().nullable().default(null),
});
/** `source` and `observedAt` are absent in replies of releases before paging. */
export const reforgerBans = z.object({
  bans: z.array(reforgerBan).max(10000),
  source: z.enum(['live', 'snapshot']).default('live'),
  observedAt: z.number().nullable().default(null),
});
/** Whether a recent complete copy of the native list exists for search and checks. */
export const reforgerBanSnapshotState = z.object({
  state: z.enum(['complete', 'loading', 'unavailable']),
  observedAt: z.number().nullable(),
});
export const reforgerBanPage = z.object({
  page: z.number().int().min(1).max(400),
  pages: z.number().int().min(1).max(400),
  total: z.number().int().min(0).max(10000),
  bans: z.array(reforgerBan).max(25),
  snapshot: reforgerBanSnapshotState,
});
export const reforgerBanSearch = z.object({
  bans: z.array(reforgerBan).max(100),
  more: z.boolean(),
  snapshot: reforgerBanSnapshotState,
});
export const reforgerCommandHistory = z
  .array(
    z.object({
      id: z.number(),
      at: z.number().nullable(),
      actorName: z.string().nullable(),
      action: z.string(),
      outcome: z.string().nullable(),
      target: z.string().nullable(),
      reason: z.string().nullable(),
      failure: z.string().nullable(),
    }),
  )
  .max(25);
