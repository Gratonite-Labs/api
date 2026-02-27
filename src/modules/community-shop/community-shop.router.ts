import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { createCommunityShopService } from './community-shop.service.js';
import {
  browseCommunityItemsSchema,
  createCommunityItemSchema,
  installCommunityItemSchema,
  moderationDecisionSchema,
  reportCommunityItemSchema,
} from './community-shop.schemas.js';

export function communityShopRouter(ctx: AppContext): Router {
  const router = Router();
  const service = createCommunityShopService(ctx);
  const auth = requireAuth(ctx);
  const optAuth = optionalAuth(ctx);

  function mapServiceError(error: unknown, res: { status: (code: number) => { json: (payload: unknown) => unknown } }) {
    if (!(error instanceof Error)) return null;
    if (error.name === 'UNSAFE_PAYLOAD') {
      return res.status(400).json({
        code: 'UNSAFE_PAYLOAD',
        message: 'Payload failed safety checks. Remove scripts/executable content and retry.',
      });
    }
    if (error.name === 'FORBIDDEN') {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }
    if (error.name === 'INVALID_TRANSITION') {
      return res.status(409).json({ code: 'INVALID_TRANSITION' });
    }
    return null;
  }

  router.get('/community-items', optAuth, async (req, res) => {
    const parsed = browseCommunityItemsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    const items = await service.listItems(parsed.data, req.user?.userId);
    return res.json(items);
  });

  router.post('/community-items', auth, async (req, res) => {
    const parsed = createCommunityItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    try {
      const created = await service.createItem(req.user!.userId, parsed.data);
      return res.status(201).json(created);
    } catch (error) {
      const mapped = mapServiceError(error, res);
      if (mapped) return mapped;
      throw error;
    }
  });

  router.post('/community-items/:itemId/submit', auth, async (req, res) => {
    try {
      const updated = await service.submitForReview(req.params.itemId, req.user!.userId);
      if (!updated) return res.status(404).json({ code: 'ITEM_NOT_FOUND' });
      return res.json(updated);
    } catch (error) {
      const mapped = mapServiceError(error, res);
      if (mapped) return mapped;
      throw error;
    }
  });

  router.get('/community-items/moderation/queue', auth, async (req, res) => {
    const limit = Number(req.query['limit'] ?? 50);
    try {
      const queue = await service.getModerationQueue(req.user!.userId, Number.isFinite(limit) ? limit : 50);
      return res.json(queue);
    } catch (error) {
      const mapped = mapServiceError(error, res);
      if (mapped) return mapped;
      throw error;
    }
  });

  router.post('/community-items/:itemId/moderation/decision', auth, async (req, res) => {
    const parsed = moderationDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    try {
      const updated = await service.moderateItem(req.params.itemId, req.user!.userId, parsed.data);
      if (!updated) return res.status(404).json({ code: 'ITEM_NOT_FOUND' });
      return res.json(updated);
    } catch (error) {
      const mapped = mapServiceError(error, res);
      if (mapped) return mapped;
      throw error;
    }
  });

  router.post('/community-items/:itemId/install', auth, async (req, res) => {
    const parsed = installCommunityItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    const installed = await service.installItem(req.user!.userId, req.params.itemId, parsed.data);
    if (!installed) return res.status(404).json({ code: 'ITEM_NOT_AVAILABLE' });
    return res.status(201).json(installed);
  });

  router.delete('/community-items/:itemId/install', auth, async (req, res) => {
    const parsed = installCommunityItemSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    const removed = await service.uninstallItem(req.user!.userId, req.params.itemId, parsed.data);
    if (!removed) return res.status(404).json({ code: 'NOT_INSTALLED' });
    return res.status(204).send();
  });

  router.post('/community-items/:itemId/report', auth, async (req, res) => {
    const parsed = reportCommunityItemSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    const report = await service.reportItem(req.user!.userId, req.params.itemId, parsed.data);
    if (!report) return res.status(404).json({ code: 'ITEM_NOT_FOUND' });
    return res.status(201).json(report);
  });

  router.get('/users/@me/community-items', auth, async (req, res) => {
    const payload = await service.getMyItems(req.user!.userId);
    return res.json(payload);
  });

  return router;
}
