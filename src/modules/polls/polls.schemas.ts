import { z } from 'zod';

export const createPollOptionSchema = z.object({
  text: z.string().min(1).max(55),
  emoji: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
});

export const createPollSchema = z.object({
  question: z.string().min(1).max(300),
  answers: z.array(createPollOptionSchema).min(2).max(10),
  duration: z.number().int().min(1).max(768).optional(), // hours; max 32 days
  allowMultiselect: z.boolean().default(false),
  layoutType: z.enum(['default']).default('default'),
});

export const voteSchema = z.object({
  optionIds: z.array(z.string()).min(1),
});

export type CreatePollInput = z.infer<typeof createPollSchema>;
export type VoteInput = z.infer<typeof voteSchema>;
