import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth, optionalAuth } from '../../middleware/auth.js';
import { createThemesService } from './themes.service.js';
import {
  createThemeSchema,
  updateThemeSchema,
  browseThemesSchema,
  installThemeSchema,
  rateThemeSchema,
} from './themes.schemas.js';

export function themesRouter(ctx: AppContext): Router {
  const router = Router();
  const themesService = createThemesService(ctx);
  const auth = requireAuth(ctx);
  const optAuth = optionalAuth(ctx);

  // ── Browse themes (built-in + public marketplace) ───────────────────────
  router.get('/themes', optAuth, async (req, res) => {
    const parsed = browseThemesSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const themes = await themesService.browseThemes(parsed.data);
    res.json(themes);
  });

  // ── Get single theme ───────────────────────────────────────────────────
  router.get('/themes/:themeId', optAuth, async (req, res) => {
    const theme = await themesService.getTheme(req.params.themeId);
    if (!theme) {
      return res.status(404).json({ code: 'THEME_NOT_FOUND' });
    }

    // Non-public themes only visible to author
    if (
      theme.visibility !== 'public' &&
      (!req.user || req.user.userId !== theme.authorId)
    ) {
      return res.status(404).json({ code: 'THEME_NOT_FOUND' });
    }

    res.json(theme);
  });

  // ── Create custom theme ────────────────────────────────────────────────
  router.post('/themes', auth, async (req, res) => {
    const parsed = createThemeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const theme = await themesService.createTheme(req.user!.userId, parsed.data);
    res.status(201).json(theme);
  });

  // ── Update own theme ───────────────────────────────────────────────────
  router.patch('/themes/:themeId', auth, async (req, res) => {
    const parsed = updateThemeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const theme = await themesService.updateTheme(
      req.params.themeId,
      req.user!.userId,
      parsed.data,
    );
    if (!theme) {
      return res.status(404).json({ code: 'THEME_NOT_FOUND' });
    }

    res.json(theme);
  });

  // ── Delete own theme ───────────────────────────────────────────────────
  router.delete('/themes/:themeId', auth, async (req, res) => {
    const deleted = await themesService.deleteTheme(req.params.themeId, req.user!.userId);
    if (!deleted) {
      return res.status(404).json({ code: 'THEME_NOT_FOUND' });
    }
    res.status(204).send();
  });

  // ── Publish theme to marketplace ───────────────────────────────────────
  router.post('/themes/:themeId/publish', auth, async (req, res) => {
    const theme = await themesService.publishTheme(req.params.themeId, req.user!.userId);
    if (!theme) {
      return res.status(404).json({ code: 'THEME_NOT_FOUND' });
    }
    res.json(theme);
  });

  // ── Install theme ──────────────────────────────────────────────────────
  router.post('/themes/:themeId/install', auth, async (req, res) => {
    const parsed = installThemeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const install = await themesService.installTheme(
      req.user!.userId,
      req.params.themeId,
      parsed.data.scope,
      parsed.data.scopeId,
    );
    if (!install) {
      return res.status(404).json({ code: 'THEME_NOT_FOUND' });
    }
    res.status(201).json(install);
  });

  // ── Uninstall theme ────────────────────────────────────────────────────
  router.delete('/themes/:themeId/install', auth, async (req, res) => {
    const removed = await themesService.uninstallTheme(
      req.user!.userId,
      req.params.themeId,
    );
    if (!removed) {
      return res.status(404).json({ code: 'NOT_INSTALLED' });
    }
    res.status(204).send();
  });

  // ── Rate theme ─────────────────────────────────────────────────────────
  router.post('/themes/:themeId/rate', auth, async (req, res) => {
    const parsed = rateThemeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await themesService.rateTheme(
      req.user!.userId,
      req.params.themeId,
      parsed.data.rating,
    );
    res.json(result);
  });

  // ── Get user's themes (created + installed) ────────────────────────────
  router.get('/users/@me/themes', auth, async (req, res) => {
    const themes = await themesService.getUserThemes(req.user!.userId);
    res.json(themes);
  });

  return router;
}
