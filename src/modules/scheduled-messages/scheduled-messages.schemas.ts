import { z } from 'zod';

export const createScheduledMessageSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1).max(4000),
  scheduledFor: z.string().datetime(),
  embeds: z.array(z.record(z.unknown())).max(10).default([]),
});

export const listScheduledMessagesSchema = z.object({
  channelId: z.string().optional(),
  status: z.enum(['pending', 'sent', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateScheduledMessageInput = z.infer<typeof createScheduledMessageSchema>;
export type ListScheduledMessagesInput = z.infer<typeof listScheduledMessagesSchema>;
