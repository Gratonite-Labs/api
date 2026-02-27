import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createAnalyticsService } from './analytics.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { getAnalyticsSchema, getHeatmapSchema } from './analytics.schemas.js';

export function analyticsRouter(ctx: AppContext): Router {
  const router = Router();
  const analyticsService = createAnalyticsService(ctx);
  const guildsService = createGuildsService(ctx);
  const auth = requireAuth(ctx);

  async function checkOwner(guildId: string, userId: string) {
    const guild = await guildsService.getGuild(guildId);
    return guild?.ownerId === userId;
  }

  // ── Get daily analytics ───────────────────────────────────────────────

  router.get('/guilds/:guildId/analytics', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getAnalyticsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const data = await analyticsService.getDailyAnalytics(guildId, parsed.data.period);
    res.json(data);
  });

  // ── Get hourly heatmap ────────────────────────────────────────────────

  router.get('/guilds/:guildId/analytics/heatmap', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getHeatmapSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const data = await analyticsService.getHourlyHeatmap(guildId, parsed.data.days);
    res.json(data);
  });

  return router;
}
