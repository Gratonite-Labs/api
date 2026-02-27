import { z } from 'zod';

export const createThreadSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['public', 'private', 'announcement']).default('public'),
  autoArchiveDuration: z.number().int().min(60).max(10080).optional(),
  invitable: z.boolean().optional(),
  appliedTags: z.array(z.string()).max(5).optional(),
  message: z.string().min(1).max(4000).optional(),
});

export const updateThreadSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  archived: z.boolean().optional(),
  locked: z.boolean().optional(),
  autoArchiveDuration: z.number().int().min(60).max(10080).optional(),
  invitable: z.boolean().optional(),
  appliedTags: z.array(z.string()).max(5).optional(),
  pinned: z.boolean().optional(),
});

export const getThreadsSchema = z.object({
  archived: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
});

export type CreateThreadInput = z.infer<typeof createThreadSchema>;
export type UpdateThreadInput = z.infer<typeof updateThreadSchema>;
