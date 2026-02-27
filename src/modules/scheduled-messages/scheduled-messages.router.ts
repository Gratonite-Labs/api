import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createScheduledMessagesService } from './scheduled-messages.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { createScheduledMessageSchema, listScheduledMessagesSchema } from './scheduled-messages.schemas.js';

export function scheduledMessagesRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const service = createScheduledMessagesService(ctx);
  const guildsService = createGuildsService(ctx);

  // ── GET /guilds/:guildId/scheduled-messages — List ─────────────────────
  router.get('/guilds/:guildId/scheduled-messages', auth, async (req, res) => {
    const isMember = await guildsService.isMember(req.params.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = listScheduledMessagesSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const messages = await service.list(req.params.guildId, parsed.data);
    res.json(messages);
  });

  // ── POST /guilds/:guildId/scheduled-messages — Create ─────────────────
  router.post('/guilds/:guildId/scheduled-messages', auth, async (req, res) => {
    const isMember = await guildsService.isMember(req.params.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = createScheduledMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const msg = await service.create(req.params.guildId, req.user!.userId, parsed.data);
    res.status(201).json(msg);
  });

  // ── GET /guilds/:guildId/scheduled-messages/:messageId — Get one ───────
  router.get('/guilds/:guildId/scheduled-messages/:messageId', auth, async (req, res) => {
    const msg = await service.getById(req.params.messageId);
    if (!msg || msg.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Scheduled message not found' });
    }
    res.json(msg);
  });

  // ── DELETE /guilds/:guildId/scheduled-messages/:messageId — Cancel ─────
  router.delete('/guilds/:guildId/scheduled-messages/:messageId', auth, async (req, res) => {
    const result = await service.cancel(req.params.messageId, req.user!.userId);

    if ('error' in result) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        FORBIDDEN: 403,
        NOT_PENDING: 409,
      };
      return res.status(statusMap[result.error] ?? 400).json({ code: result.error });
    }

    res.status(204).send();
  });

  return router;
}
