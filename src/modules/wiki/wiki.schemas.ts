import { z } from 'zod';

export const createWikiPageSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(50000).default(''),
  parentPageId: z.string().optional(),
  pinned: z.boolean().optional(),
});

export const updateWikiPageSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(50000).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  parentPageId: z.string().nullable().optional(),
  position: z.number().int().min(0).optional(),
  editMessage: z.string().max(300).optional(),
});

export const getWikiPagesSchema = z.object({
  parentPageId: z.string().optional(),
  archived: z
    .string()
    .transform((v) => v === 'true')
    .or(z.boolean())
    .optional(),
});

export const getWikiRevisionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().optional(),
});

export type CreateWikiPageInput = z.infer<typeof createWikiPageSchema>;
export type UpdateWikiPageInput = z.infer<typeof updateWikiPageSchema>;
