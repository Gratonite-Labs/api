import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createModerationService } from './moderation.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import {
  updateRaidConfigSchema,
  createReportSchema,
  updateReportSchema,
  getReportsSchema,
  getDashboardStatsSchema,
  getModActionsSchema,
} from './moderation.schemas.js';

export function moderationRouter(ctx: AppContext): Router {
  const router = Router();
  const moderationService = createModerationService(ctx);
  const guildsService = createGuildsService(ctx);
  const auth = requireAuth(ctx);

  async function checkOwner(guildId: string, userId: string) {
    const guild = await guildsService.getGuild(guildId);
    return guild?.ownerId === userId;
  }

  // ── Raid config ─────────────────────────────────────────────────────────

  router.get('/guilds/:guildId/raid-config', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const config = await moderationService.getRaidConfig(guildId);
    res.json(config);
  });

  router.patch('/guilds/:guildId/raid-config', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateRaidConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const config = await moderationService.updateRaidConfig(guildId, parsed.data);
    res.json(config);
  });

  router.post('/guilds/:guildId/raid-resolve', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await moderationService.resolveRaid(guildId);
    res.json({ resolved: true });
  });

  // ── Reports ─────────────────────────────────────────────────────────────

  router.post('/guilds/:guildId/reports', auth, async (req, res) => {
    const { guildId } = req.params;
    const isMember = await guildsService.isMember(guildId, req.user!.userId);
    if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });

    const parsed = createReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const report = await moderationService.createReport(guildId, req.user!.userId, parsed.data);
    res.status(201).json(report);
  });

  router.get('/guilds/:guildId/reports', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getReportsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const reportList = await moderationService.getReports(guildId, parsed.data);
    res.json(reportList);
  });

  router.get('/guilds/:guildId/reports/:reportId', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const report = await moderationService.getReport(req.params.reportId);
    if (!report || report.guildId !== guildId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    res.json(report);
  });

  router.patch('/guilds/:guildId/reports/:reportId', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await moderationService.updateReport(
      req.params.reportId,
      req.user!.userId,
      parsed.data,
    );
    if (!updated) return res.status(404).json({ code: 'NOT_FOUND' });

    res.json(updated);
  });

  // ── Dashboard ───────────────────────────────────────────────────────────

  router.get('/guilds/:guildId/moderation/dashboard', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getDashboardStatsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const stats = await moderationService.getDashboardStats(guildId, parsed.data.days);
    res.json(stats);
  });

  router.get('/guilds/:guildId/moderation/actions', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getModActionsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const actions = await moderationService.getRecentModActions(guildId, parsed.data.limit);
    res.json(actions);
  });

  return router;
}
