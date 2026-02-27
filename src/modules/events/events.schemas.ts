import { z } from 'zod';

export const createEventSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    scheduledStartTime: z.string().datetime(),
    scheduledEndTime: z.string().datetime().optional(),
    entityType: z.enum(['stage_instance', 'voice', 'external']),
    channelId: z.string().optional(),
    entityMetadata: z
      .object({
        location: z.string().max(100).optional(),
      })
      .optional(),
  })
  .refine(
    (data) => {
      // External events don't need channelId but need location
      if (data.entityType === 'external') return true;
      return !!data.channelId;
    },
    { message: 'channelId is required for voice and stage events' },
  );

export const updateEventSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
  scheduledStartTime: z.string().datetime().optional(),
  scheduledEndTime: z.string().datetime().nullable().optional(),
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
  entityMetadata: z
    .object({
      location: z.string().max(100).optional(),
    })
    .optional(),
});

export const getEventsSchema = z.object({
  status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
