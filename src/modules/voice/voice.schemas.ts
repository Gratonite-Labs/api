import { z } from 'zod';

export const joinVoiceSchema = z.object({
  channelId: z.string(),
  selfMute: z.boolean().default(false),
  selfDeaf: z.boolean().default(false),
});

export const updateVoiceStateSchema = z.object({
  selfMute: z.boolean().optional(),
  selfDeaf: z.boolean().optional(),
  selfVideo: z.boolean().optional(),
  selfStream: z.boolean().optional(),
});

export const modifyMemberVoiceStateSchema = z.object({
  mute: z.boolean().optional(),
  deaf: z.boolean().optional(),
  suppress: z.boolean().optional(),
  channelId: z.string().nullable().optional(), // null = disconnect, string = move
});

export const createStageInstanceSchema = z.object({
  channelId: z.string(),
  topic: z.string().min(1).max(120),
  privacyLevel: z.enum(['public', 'guild_only']).default('guild_only'),
});

export const updateStageInstanceSchema = z.object({
  topic: z.string().min(1).max(120).optional(),
  privacyLevel: z.enum(['public', 'guild_only']).optional(),
});

export const createSoundboardSoundSchema = z.object({
  name: z.string().min(1).max(32),
  soundHash: z.string().min(1),
  volume: z.number().min(0).max(1).default(1.0),
  emojiId: z.string().optional(),
  emojiName: z.string().max(64).optional(),
});

export const updateSoundboardSoundSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  volume: z.number().min(0).max(1).optional(),
  emojiId: z.string().nullable().optional(),
  emojiName: z.string().max(64).nullable().optional(),
  available: z.boolean().optional(),
});

export const startScreenShareSchema = z.object({
  quality: z.enum(['standard', 'high', 'source']).default('standard'),
  shareType: z.enum(['screen', 'window', 'tab', 'game']).default('screen'),
  audioEnabled: z.boolean().default(true),
});

export type JoinVoiceInput = z.infer<typeof joinVoiceSchema>;
export type UpdateVoiceStateInput = z.infer<typeof updateVoiceStateSchema>;
export type ModifyMemberVoiceStateInput = z.infer<typeof modifyMemberVoiceStateSchema>;
export type CreateStageInstanceInput = z.infer<typeof createStageInstanceSchema>;
export type UpdateStageInstanceInput = z.infer<typeof updateStageInstanceSchema>;
export type CreateSoundboardSoundInput = z.infer<typeof createSoundboardSoundSchema>;
export type UpdateSoundboardSoundInput = z.infer<typeof updateSoundboardSoundSchema>;
export type StartScreenShareInput = z.infer<typeof startScreenShareSchema>;
