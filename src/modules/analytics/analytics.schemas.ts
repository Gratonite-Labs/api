import { z } from 'zod';

export const getAnalyticsSchema = z.object({
  period: z.enum(['7d', '14d', '30d', '90d']).default('7d'),
});

export const getHeatmapSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});
