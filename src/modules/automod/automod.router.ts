import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createAutoModService } from './automod.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import {
  createAutoModRuleSchema,
  updateAutoModRuleSchema,
  getAutoModLogsSchema,
} from './automod.schemas.js';

export function autoModRouter(ctx: AppContext): Router {
  const router = Router();
  const autoModService = createAutoModService(ctx);
  const guildsService = createGuildsService(ctx);
  const auth = requireAuth(ctx);

  async function checkOwner(guildId: string, userId: string) {
    const guild = await guildsService.getGuild(guildId);
    return guild?.ownerId === userId;
  }

  // ── Create auto-mod rule ──────────────────────────────────────────────────

  router.post('/guilds/:guildId/auto-moderation/rules', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = createAutoModRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await autoModService.createRule(guildId, req.user!.userId, parsed.data);
    if (result && typeof result === 'object' && 'error' in result) {
      return res.status(400).json({ code: result.error });
    }

    res.status(201).json(result);
  });

  // ── List auto-mod rules ───────────────────────────────────────────────────

  router.get('/guilds/:guildId/auto-moderation/rules', auth, async (req, res) => {
    const { guildId } = req.params;
    const isMember = await guildsService.isMember(guildId, req.user!.userId);
    if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });

    const rules = await autoModService.getRules(guildId);
    res.json(rules);
  });

  // ── Get single auto-mod rule ──────────────────────────────────────────────

  router.get('/guilds/:guildId/auto-moderation/rules/:ruleId', auth, async (req, res) => {
    const { guildId } = req.params;
    const isMember = await guildsService.isMember(guildId, req.user!.userId);
    if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });

    const rule = await autoModService.getRule(req.params.ruleId);
    if (!rule || rule.guildId !== guildId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    res.json(rule);
  });

  // ── Update auto-mod rule ──────────────────────────────────────────────────

  router.patch('/guilds/:guildId/auto-moderation/rules/:ruleId', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateAutoModRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await autoModService.updateRule(req.params.ruleId, guildId, parsed.data);
    if (!updated) return res.status(404).json({ code: 'NOT_FOUND' });

    res.json(updated);
  });

  // ── Delete auto-mod rule ──────────────────────────────────────────────────

  router.delete('/guilds/:guildId/auto-moderation/rules/:ruleId', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const deleted = await autoModService.deleteRule(req.params.ruleId, guildId);
    if (!deleted) return res.status(404).json({ code: 'NOT_FOUND' });

    res.status(204).send();
  });

  // ── Get auto-mod action logs ──────────────────────────────────────────────

  router.get('/guilds/:guildId/auto-moderation/logs', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getAutoModLogsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const logs = await autoModService.getActionLogs(guildId, parsed.data);
    res.json(logs);
  });

  return router;
}
