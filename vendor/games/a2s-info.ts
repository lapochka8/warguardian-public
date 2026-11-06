import { z } from 'zod';

/** The fields WarGuardian keeps from one Steam A2S_INFO reply. */
export const a2sInfoSchema = z.object({
  name: z.string().max(512),
  map: z.string().max(512),
  game: z.string().max(512),
  version: z.string().max(512),
  players: z.number().int().min(0).max(255),
  capacity: z.number().int().min(0).max(255),
  passworded: z.boolean(),
  secure: z.boolean(),
  observedAt: z.number(),
});
export type A2sInfo = z.infer<typeof a2sInfoSchema>;
