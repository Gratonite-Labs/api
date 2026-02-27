import { z } from 'zod';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color');

const tokenValueSchema = z.string().max(200);

export const createThemeSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(500).optional(),
  tokens: z.record(z.string().max(64), tokenValueSchema).refine(
    (tokens) => Object.keys(tokens).length >= 3 && Object.keys(tokens).length <= 150,
    { message: 'Tokens must have between 3 and 150 entries' },
  ),
  tags: z.array(z.string().max(32)).max(10).default([]),
  previewColors: z.array(hexColor).min(1).max(5).default(['#7C6AFF']),
  visibility: z.enum(['private', 'unlisted', 'public']).default('private'),
});

export const updateThemeSchema = createThemeSchema.partial();

export const browseThemesSchema = z.object({
  tag: z.string().max(32).optional(),
  sort: z.enum(['popular', 'newest', 'top_rated']).default('popular'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  builtIn: z.coerce.boolean().optional(),
});

export const installThemeSchema = z.object({
  scope: z.enum(['personal', 'guild']).default('personal'),
  scopeId: z.string().max(64).optional(),
});

export const rateThemeSchema = z.object({
  rating: z.number().int().min(1).max(5),
});

export type CreateThemeInput = z.infer<typeof createThemeSchema>;
export type UpdateThemeInput = z.infer<typeof updateThemeSchema>;
export type BrowseThemesInput = z.infer<typeof browseThemesSchema>;
