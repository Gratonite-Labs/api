import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createBotsService } from './bots.service.js';
import {
  authorizeSchema,
  createAppSchema,
  createSlashCommandSchema,
  tokenSchema,
  updateAppSchema,
  updateSlashCommandSchema,
} from './bots.schemas.js';
import { createGuildsService } from '../guilds/guilds.service.js';

export function botsRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const botsService = createBotsService(ctx);
  const guildsService = createGuildsService(ctx);

  function sanitizeApp(app: any) {
    if (!app) return app;
    const { clientSecretHash: _secret, ...rest } = app;
    return rest;
  }

  // ── OAuth app management ───────────────────────────────────────────────

  router.post('/oauth/apps', auth, async (req, res) => {
    const parsed = createAppSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await botsService.createApp(req.user!.userId, parsed.data);
    res.status(201).json({ app: sanitizeApp(result.app), clientSecret: result.clientSecret });
  });

  router.get('/oauth/apps', auth, async (req, res) => {
    const apps = await botsService.listApps(req.user!.userId);
    res.json(apps.map(sanitizeApp));
  });

  router.get('/oauth/apps/:appId', auth, async (req, res) => {
    const app = await botsService.getApp(req.params.appId);
    if (!app || app.ownerId !== req.user!.userId) return res.status(404).json({ code: 'NOT_FOUND' });
    res.json(sanitizeApp(app));
  });

  router.patch('/oauth/apps/:appId', auth, async (req, res) => {
    const parsed = updateAppSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await botsService.updateApp(req.params.appId, req.user!.userId, parsed.data);
    if (!updated) return res.status(404).json({ code: 'NOT_FOUND' });
    res.json(sanitizeApp(updated));
  });

  router.delete('/oauth/apps/:appId', auth, async (req, res) => {
    const deleted = await botsService.deleteApp(req.params.appId, req.user!.userId);
    if (!deleted) return res.status(404).json({ code: 'NOT_FOUND' });
    res.status(204).send();
  });

  router.post('/oauth/apps/:appId/reset-secret', auth, async (req, res) => {
    const result = await botsService.resetSecret(req.params.appId, req.user!.userId);
    if (!result) return res.status(404).json({ code: 'NOT_FOUND' });
    res.json({ app: sanitizeApp(result.app), clientSecret: result.clientSecret });
  });

  // ── OAuth authorize/token ─────────────────────────────────────────────-

  router.post('/oauth/authorize', auth, async (req, res) => {
    const parsed = authorizeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await botsService.authorize(req.user!.userId, parsed.data);
    if ('error' in result) return res.status(400).json({ code: result.error });
    res.json({ code: result.code, state: parsed.data.state });
  });

  router.post('/oauth/token', async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await botsService.exchangeToken(parsed.data);
    if ('error' in result) return res.status(400).json({ code: result.error });
    res.json(result);
  });

  // ── Bot lifecycle ─────────────────────────────────────────────────────-

  router.post('/oauth/apps/:appId/bot', auth, async (req, res) => {
    const result = await botsService.createBot(req.params.appId, req.user!.userId);
    if ('error' in result) return res.status(403).json({ code: result.error });
    res.status(201).json(result);
  });

  router.post('/oauth/apps/:appId/bot/reset-token', auth, async (req, res) => {
    const result = await botsService.resetBotToken(req.params.appId, req.user!.userId);
    if ('error' in result) return res.status(403).json({ code: result.error });
    res.json(result);
  });

  router.post('/oauth/apps/:appId/bot/authorize', auth, async (req, res) => {
    const { guildId } = req.body ?? {};
    if (!guildId || typeof guildId !== 'string') {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'guildId is required' });
    }

    const app = await botsService.getApp(req.params.appId);
    if (!app || app.ownerId !== req.user!.userId) return res.status(404).json({ code: 'NOT_FOUND' });

    const bot = await botsService.getBot(req.params.appId);
    if (!bot) return res.status(404).json({ code: 'BOT_NOT_FOUND' });

    const isMember = await guildsService.isMember(guildId, bot.userId);
    if (!isMember) {
      await guildsService.addMember(guildId, bot.userId);
    }

    res.status(204).send();
  });

  // ── Slash commands ─────────────────────────────────────────────────----

  router.get('/oauth/apps/:appId/commands', auth, async (req, res) => {
    const commands = await botsService.listSlashCommands(req.params.appId, req.user!.userId);
    if (!commands) return res.status(404).json({ code: 'NOT_FOUND' });
    res.json(commands);
  });

  router.post('/oauth/apps/:appId/commands', auth, async (req, res) => {
    const parsed = createSlashCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const command = await botsService.createSlashCommand(
      req.params.appId,
      req.user!.userId,
      parsed.data,
    );
    if (!command) return res.status(404).json({ code: 'NOT_FOUND' });
    res.status(201).json(command);
  });

  router.patch('/oauth/apps/:appId/commands/:commandId', auth, async (req, res) => {
    const parsed = updateSlashCommandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await botsService.updateSlashCommand(
      req.params.appId,
      req.user!.userId,
      req.params.commandId,
      parsed.data,
    );
    if (!updated) return res.status(404).json({ code: 'NOT_FOUND' });
    res.json(updated);
  });

  router.delete('/oauth/apps/:appId/commands/:commandId', auth, async (req, res) => {
    const deleted = await botsService.deleteSlashCommand(
      req.params.appId,
      req.user!.userId,
      req.params.commandId,
    );
    if (!deleted) return res.status(404).json({ code: 'NOT_FOUND' });
    res.status(204).send();
  });

  return router;
}
