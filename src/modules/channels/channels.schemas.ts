import { z } from 'zod';

const channelTypes = [
  'GUILD_TEXT',
  'GUILD_VOICE',
  'GUILD_CATEGORY',
  'GUILD_ANNOUNCEMENT',
  'GUILD_STAGE_VOICE',
  'GUILD_FORUM',
  'GUILD_MEDIA',
  'GUILD_WIKI',
  'GUILD_QA',
] as const;

export const createChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .transform((n) => n.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '')),
  type: z.enum(channelTypes),
  topic: z.string().max(1024).optional(),
  parentId: z.string().optional(), // category ID
  nsfw: z.boolean().optional(),
  rateLimitPerUser: z.number().int().min(0).max(21600).optional(), // 0 to 6 hours
  position: z.number().int().min(0).optional(),
});

export const updateChannelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  topic: z.string().max(1024).nullable().optional(),
  nsfw: z.boolean().optional(),
  rateLimitPerUser: z.number().int().min(0).max(21600).optional(),
  parentId: z.string().nullable().optional(),
  position: z.number().int().min(0).optional(),
});

export const reorderChannelsSchema = z.object({
  channels: z.array(
    z.object({
      id: z.string(),
      position: z.number().int().min(0),
      parentId: z.string().nullable().optional(),
    }),
  ),
});

export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;
