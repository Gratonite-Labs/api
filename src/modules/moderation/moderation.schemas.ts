import { z } from 'zod';

export const updateRaidConfigSchema = z.object({
  enabled: z.boolean().optional(),
  joinThreshold: z.number().int().min(2).max(100).optional(),
  joinWindowSeconds: z.number().int().min(5).max(600).optional(),
  action: z
    .enum(['kick', 'ban', 'enable_verification', 'lock_channels', 'alert_only'])
    .optional(),
  autoResolveMinutes: z.number().int().min(5).max(1440).optional(),
});

export const createReportSchema = z.object({
  reportedUserId: z.string(),
  messageId: z.string().optional(),
  reason: z.enum(['spam', 'harassment', 'hate_speech', 'nsfw', 'self_harm', 'other']),
  description: z.string().max(1000).optional(),
});

export const updateReportSchema = z.object({
  status: z.enum(['reviewing', 'resolved', 'dismissed']),
  resolutionNote: z.string().max(2000).optional(),
});

export const getReportsSchema = z.object({
  status: z.enum(['pending', 'reviewing', 'resolved', 'dismissed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});

export const getDashboardStatsSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export const getModActionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type UpdateRaidConfigInput = z.infer<typeof updateRaidConfigSchema>;
export type CreateReportInput = z.infer<typeof createReportSchema>;
export type UpdateReportInput = z.infer<typeof updateReportSchema>;
