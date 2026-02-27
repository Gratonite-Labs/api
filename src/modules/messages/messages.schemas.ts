import { z } from 'zod';

const pollAnswerSchema = z.object({
  text: z.string().min(1).max(255),
  emojiId: z.string().optional(),
  emojiName: z.string().max(64).optional(),
});

export const pollInputSchema = z.object({
  questionText: z.string().min(1).max(300),
  answers: z.array(pollAnswerSchema).min(2).max(10),
  allowMultiselect: z.boolean().optional(),
  expiry: z.string().datetime().optional(),
});

export const createMessageSchema = z
  .object({
    content: z.string().max(4000).optional(),
    nonce: z.string().max(64).optional(),
    tts: z.boolean().optional(),
    messageReference: z
      .object({
        messageId: z.string(),
      })
      .optional(),
    stickerIds: z.array(z.string()).max(3).optional(),
    attachmentIds: z.array(z.string()).max(10).optional(),
    poll: pollInputSchema.optional(),
  })
  .refine(
    (data) =>
      Boolean(
        (data.content && data.content.length > 0) ||
          (data.attachmentIds && data.attachmentIds.length > 0) ||
          (data.stickerIds && data.stickerIds.length > 0) ||
          data.poll,
      ),
    {
      message: 'Message must include content, attachments, stickers, or a poll',
    },
  );

export const updateMessageSchema = z.object({
  content: z.string().min(0).max(4000),
});

export const getMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
  after: z.string().optional(),
  around: z.string().optional(),
});

const embedSchema = z.object({}).passthrough();

export const createScheduledMessageSchema = z
  .object({
    content: z.string().min(1).max(4000).optional(),
    embeds: z.array(embedSchema).max(10).optional(),
    attachmentIds: z.array(z.string()).max(10).optional(),
    scheduledFor: z.string().datetime(),
  })
  .refine(
    (data) =>
      Boolean(
        (data.content && data.content.length > 0) ||
          (data.attachmentIds && data.attachmentIds.length > 0) ||
          (data.embeds && data.embeds.length > 0),
      ),
    {
      message: 'Scheduled message must include content, attachments, or embeds',
    },
  );

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type UpdateMessageInput = z.infer<typeof updateMessageSchema>;
export type CreateScheduledMessageInput = z.infer<typeof createScheduledMessageSchema>;
