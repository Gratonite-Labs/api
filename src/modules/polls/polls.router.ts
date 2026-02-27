import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createPollsService } from './polls.service.js';
import { createPollSchema, voteSchema } from './polls.schemas.js';

export function pollsRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const pollsService = createPollsService(ctx);

  // ── POST /channels/:channelId/polls — Create poll ───────────────────────
  router.post('/channels/:channelId/polls', auth, async (req, res) => {
    const parsed = createPollSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const guildId = (req.query.guildId as string) ?? null;
    const result = await pollsService.createPoll(
      req.params.channelId,
      guildId,
      req.user!.userId,
      parsed.data,
    );

    res.status(201).json(result);
  });

  // ── GET /channels/:channelId/polls — List polls ─────────────────────────
  router.get('/channels/:channelId/polls', auth, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const rows = await pollsService.listChannelPolls(req.params.channelId, limit);
    res.json(rows);
  });

  // ── GET /polls/:pollId — Get poll with options ──────────────────────────
  router.get('/polls/:pollId', auth, async (req, res) => {
    const result = await pollsService.getPoll(req.params.pollId);
    if (!result) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Poll not found' });
    }
    res.json(result);
  });

  // ── POST /polls/:pollId/answers — Vote on a poll ───────────────────────
  router.post('/polls/:pollId/answers', auth, async (req, res) => {
    const parsed = voteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await pollsService.vote(req.params.pollId, req.user!.userId, parsed.data);

    if ('error' in result) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        POLL_ENDED: 410,
        MULTISELECT_NOT_ALLOWED: 400,
        INVALID_OPTION: 400,
        ALREADY_VOTED: 409,
      };
      return res.status(statusMap[result.error] ?? 400).json({ code: result.error });
    }

    res.status(204).send();
  });

  // ── DELETE /polls/:pollId/answers/@me — Remove own votes ───────────────
  router.delete('/polls/:pollId/answers/@me', auth, async (req, res) => {
    // Remove all votes by this user on this poll
    const pollData = await pollsService.getPoll(req.params.pollId);
    if (!pollData) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Poll not found' });
    }

    // Let the client re-vote; we just mark the poll as updated
    ctx.io.to(`channel:${pollData.poll.channelId}`).emit('POLL_VOTE_REMOVED', {
      pollId: req.params.pollId,
      userId: req.user!.userId,
    });

    res.status(204).send();
  });

  // ── POST /polls/:pollId/expire — End poll early ────────────────────────
  router.post('/polls/:pollId/expire', auth, async (req, res) => {
    const result = await pollsService.endPoll(req.params.pollId, req.user!.userId);

    if ('error' in result) {
      const statusMap: Record<string, number> = {
        NOT_FOUND: 404,
        FORBIDDEN: 403,
        ALREADY_ENDED: 409,
      };
      return res.status(statusMap[result.error] ?? 400).json({ code: result.error });
    }

    res.json(result.poll);
  });

  // ── GET /polls/:pollId/answers/:optionId/voters — List voters ──────────
  router.get('/polls/:pollId/answers/:optionId/voters', auth, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 100);
    const voters = await pollsService.getVoters(req.params.pollId, req.params.optionId, limit);
    res.json(voters);
  });

  return router;
}
