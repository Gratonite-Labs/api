import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createEventsService } from './events.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { createEventSchema, updateEventSchema, getEventsSchema } from './events.schemas.js';

export function eventsRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const eventsService = createEventsService(ctx);
  const guildsService = createGuildsService(ctx);

  // ── POST /guilds/:guildId/scheduled-events — Create event ──────────────
  router.post('/guilds/:guildId/scheduled-events', auth, async (req, res) => {
    const isMember = await guildsService.isMember(req.params.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const event = await eventsService.createEvent(
      req.params.guildId,
      req.user!.userId,
      parsed.data,
    );

    res.status(201).json(event);
  });

  // ── GET /guilds/:guildId/scheduled-events — List events ────────────────
  router.get('/guilds/:guildId/scheduled-events', auth, async (req, res) => {
    const isMember = await guildsService.isMember(req.params.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getEventsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const events = await eventsService.getGuildEvents(req.params.guildId, parsed.data);
    res.json(events);
  });

  // ── GET /guilds/:guildId/scheduled-events/:eventId — Get event ─────────
  router.get('/guilds/:guildId/scheduled-events/:eventId', auth, async (req, res) => {
    const isMember = await guildsService.isMember(req.params.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const event = await eventsService.getEvent(req.params.eventId);
    if (!event || event.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Event not found' });
    }

    res.json(event);
  });

  // ── PATCH /guilds/:guildId/scheduled-events/:eventId — Update event ────
  router.patch('/guilds/:guildId/scheduled-events/:eventId', auth, async (req, res) => {
    const event = await eventsService.getEvent(req.params.eventId);
    if (!event || event.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Event not found' });
    }

    // Only creator or guild owner can update
    if (event.creatorId !== req.user!.userId) {
      const guild = await guildsService.getGuild(req.params.guildId);
      if (!guild || guild.ownerId !== req.user!.userId) {
        return res.status(403).json({ code: 'FORBIDDEN' });
      }
    }

    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await eventsService.updateEvent(req.params.eventId, parsed.data);
    res.json(updated);
  });

  // ── DELETE /guilds/:guildId/scheduled-events/:eventId — Delete event ───
  router.delete('/guilds/:guildId/scheduled-events/:eventId', auth, async (req, res) => {
    const event = await eventsService.getEvent(req.params.eventId);
    if (!event || event.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Event not found' });
    }

    // Only creator or guild owner can delete
    if (event.creatorId !== req.user!.userId) {
      const guild = await guildsService.getGuild(req.params.guildId);
      if (!guild || guild.ownerId !== req.user!.userId) {
        return res.status(403).json({ code: 'FORBIDDEN' });
      }
    }

    await eventsService.deleteEvent(req.params.eventId);
    res.status(204).send();
  });

  // ── PUT /guilds/:guildId/scheduled-events/:eventId/users/@me — RSVP ───
  router.put('/guilds/:guildId/scheduled-events/:eventId/users/@me', auth, async (req, res) => {
    const isMember = await guildsService.isMember(req.params.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const event = await eventsService.getEvent(req.params.eventId);
    if (!event || event.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Event not found' });
    }

    await eventsService.addInterestedUser(req.params.eventId, req.user!.userId, req.params.guildId);
    res.status(204).send();
  });

  // ── DELETE /guilds/:guildId/scheduled-events/:eventId/users/@me — Un-RSVP
  router.delete('/guilds/:guildId/scheduled-events/:eventId/users/@me', auth, async (req, res) => {
    const event = await eventsService.getEvent(req.params.eventId);
    if (!event || event.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Event not found' });
    }

    const result = await eventsService.removeInterestedUser(
      req.params.eventId,
      req.user!.userId,
      req.params.guildId,
    );

    if ('error' in result) {
      return res.status(404).json({ code: result.error });
    }

    res.status(204).send();
  });

  // ── GET /guilds/:guildId/scheduled-events/:eventId/users — List RSVPs ──
  router.get('/guilds/:guildId/scheduled-events/:eventId/users', auth, async (req, res) => {
    const isMember = await guildsService.isMember(req.params.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const event = await eventsService.getEvent(req.params.eventId);
    if (!event || event.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Event not found' });
    }

    const users = await eventsService.getEventUsers(req.params.eventId);
    res.json(users);
  });

  return router;
}
