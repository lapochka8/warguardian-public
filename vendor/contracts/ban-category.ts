import { z } from 'zod';

/** Ban categories. Every ban and list entry has one. */
export const banCategories = ['cheating', 'conduct', 'other'] as const;
export const banCategorySchema = z.enum(banCategories);
export type BanCategory = z.infer<typeof banCategorySchema>;
