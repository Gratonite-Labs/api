import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createWikiService } from './wiki.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { createChannelsService } from '../channels/channels.service.js';
import {
  createWikiPageSchema,
  updateWikiPageSchema,
  getWikiPagesSchema,
  getWikiRevisionsSchema,
} from './wiki.schemas.js';

export function wikiRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const wikiService = createWikiService(ctx);
  const guildsService = createGuildsService(ctx);
  const channelsService = createChannelsService(ctx);

  // ── POST /channels/:channelId/wiki — Create wiki page ──────────────────
  router.post('/channels/:channelId/wiki', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel || !channel.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Channel not found' });
    }

    const isMember = await guildsService.isMember(channel.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = createWikiPageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await wikiService.createPage(
      req.params.channelId,
      channel.guildId,
      req.user!.userId,
      parsed.data,
    );

    if ('error' in result) {
      return res.status(400).json({ code: result.error });
    }

    res.status(201).json(result);
  });

  // ── GET /channels/:channelId/wiki — List wiki pages ────────────────────
  router.get('/channels/:channelId/wiki', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel || !channel.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Channel not found' });
    }

    const isMember = await guildsService.isMember(channel.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getWikiPagesSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const pages = await wikiService.getPages(req.params.channelId, parsed.data);
    res.json(pages);
  });

  // ── GET /wiki/:pageId — Get single wiki page ──────────────────────────
  router.get('/wiki/:pageId', auth, async (req, res) => {
    const page = await wikiService.getPage(req.params.pageId);
    if (!page) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Wiki page not found' });
    }

    const isMember = await guildsService.isMember(page.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    res.json(page);
  });

  // ── PATCH /wiki/:pageId — Update wiki page ────────────────────────────
  router.patch('/wiki/:pageId', auth, async (req, res) => {
    const page = await wikiService.getPage(req.params.pageId);
    if (!page) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Wiki page not found' });
    }

    const isMember = await guildsService.isMember(page.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateWikiPageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await wikiService.updatePage(req.params.pageId, req.user!.userId, parsed.data);

    if ('error' in result) {
      return res.status(404).json({ code: result.error });
    }

    res.json(result);
  });

  // ── DELETE /wiki/:pageId — Delete wiki page ────────────────────────────
  router.delete('/wiki/:pageId', auth, async (req, res) => {
    const page = await wikiService.getPage(req.params.pageId);
    if (!page) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Wiki page not found' });
    }

    const isMember = await guildsService.isMember(page.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await wikiService.deletePage(req.params.pageId);
    res.status(204).send();
  });

  // ── GET /wiki/:pageId/revisions — List page revisions ─────────────────
  router.get('/wiki/:pageId/revisions', auth, async (req, res) => {
    const page = await wikiService.getPage(req.params.pageId);
    if (!page) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Wiki page not found' });
    }

    const isMember = await guildsService.isMember(page.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getWikiRevisionsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const revisions = await wikiService.getRevisions(req.params.pageId, parsed.data);
    res.json(revisions);
  });

  // ── POST /wiki/:pageId/revert/:revisionId — Revert to revision ────────
  router.post('/wiki/:pageId/revert/:revisionId', auth, async (req, res) => {
    const page = await wikiService.getPage(req.params.pageId);
    if (!page) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Wiki page not found' });
    }

    const isMember = await guildsService.isMember(page.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const result = await wikiService.revertToRevision(
      req.params.pageId,
      req.params.revisionId,
      req.user!.userId,
    );

    if ('error' in result) {
      return res.status(404).json({ code: result.error });
    }

    res.json(result);
  });

  return router;
}
