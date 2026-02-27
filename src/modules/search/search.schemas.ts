import { z } from 'zod';

export const searchMessagesSchema = z.object({
  query: z.string().min(1).max(100),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  authorId: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});

export type SearchMessagesInput = z.infer<typeof searchMessagesSchema>;
