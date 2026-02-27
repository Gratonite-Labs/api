import { z } from 'zod';

// ============================================================================
// Emoji schemas
// ============================================================================

export const createEmojiSchema = z.object({
  name: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Emoji name must be alphanumeric/underscore'),
});

export const updateEmojiSchema = z.object({
  name: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_]+$/, 'Emoji name must be alphanumeric/underscore').optional(),
});

// ============================================================================
// Sticker schemas
// ============================================================================

export const createStickerSchema = z.object({
  name: z.string().min(2).max(30),
  description: z.string().max(100).optional(),
  tags: z.string().max(200).optional(), // comma-separated search tags
});

export const updateStickerSchema = z.object({
  name: z.string().min(2).max(30).optional(),
  description: z.string().max(100).nullable().optional(),
  tags: z.string().max(200).nullable().optional(),
});

export type CreateEmojiInput = z.infer<typeof createEmojiSchema>;
export type UpdateEmojiInput = z.infer<typeof updateEmojiSchema>;
export type CreateStickerInput = z.infer<typeof createStickerSchema>;
export type UpdateStickerInput = z.infer<typeof updateStickerSchema>;
