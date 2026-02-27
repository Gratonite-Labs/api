import { z } from 'zod';

export const createQuestionSchema = z.object({
  title: z.string().min(1).max(100),
  body: z.string().min(1).max(4000),
  tags: z.array(z.string()).max(5).optional(),
});

export const voteSchema = z.object({
  value: z.union([z.literal(1), z.literal(-1)]),
});

export const getQuestionsSchema = z.object({
  sort: z.enum(['votes', 'activity', 'newest']).default('activity'),
  resolved: z
    .string()
    .transform((v) => v === 'true')
    .or(z.boolean())
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.string().optional(),
});

export type CreateQuestionInput = z.infer<typeof createQuestionSchema>;
export type VoteInput = z.infer<typeof voteSchema>;
