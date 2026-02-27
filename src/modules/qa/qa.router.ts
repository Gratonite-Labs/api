import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createQaService } from './qa.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { createChannelsService } from '../channels/channels.service.js';
import { createQuestionSchema, voteSchema, getQuestionsSchema } from './qa.schemas.js';

export function qaRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const qaService = createQaService(ctx);
  const guildsService = createGuildsService(ctx);
  const channelsService = createChannelsService(ctx);

  // ── POST /channels/:channelId/questions — Create question ──────────────
  router.post('/channels/:channelId/questions', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel || !channel.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Channel not found' });
    }

    const isMember = await guildsService.isMember(channel.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = createQuestionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await qaService.createQuestion(
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

  // ── GET /channels/:channelId/questions — List questions ────────────────
  router.get('/channels/:channelId/questions', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel || !channel.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Channel not found' });
    }

    const isMember = await guildsService.isMember(channel.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = getQuestionsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const questions = await qaService.getQuestions(req.params.channelId, parsed.data);
    res.json(questions);
  });

  // ── GET /questions/:threadId — Get question detail ─────────────────────
  router.get('/questions/:threadId', auth, async (req, res) => {
    const question = await qaService.getQuestion(req.params.threadId);
    if (!question) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Question not found' });
    }

    const isMember = await guildsService.isMember(question.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    res.json(question);
  });

  // ── PUT /questions/:threadId/vote — Vote on question ───────────────────
  router.put('/questions/:threadId/vote', auth, async (req, res) => {
    const question = await qaService.getQuestion(req.params.threadId);
    if (!question) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Question not found' });
    }

    const isMember = await guildsService.isMember(question.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = voteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await qaService.voteQuestion(
      req.params.threadId,
      req.user!.userId,
      parsed.data.value,
    );

    if ('error' in result) {
      return res.status(400).json({ code: result.error });
    }

    res.json(result);
  });

  // ── DELETE /questions/:threadId/vote — Remove vote on question ─────────
  router.delete('/questions/:threadId/vote', auth, async (req, res) => {
    const result = await qaService.removeQuestionVote(req.params.threadId, req.user!.userId);

    if ('error' in result) {
      if (result.error === 'NO_VOTE') return res.status(404).json({ code: result.error });
      return res.status(400).json({ code: result.error });
    }

    res.json(result);
  });

  // ── PUT /questions/:threadId/answers/:messageId/vote — Vote on answer ──
  router.put('/questions/:threadId/answers/:messageId/vote', auth, async (req, res) => {
    const question = await qaService.getQuestion(req.params.threadId);
    if (!question) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Question not found' });
    }

    const isMember = await guildsService.isMember(question.guildId, req.user!.userId);
    if (!isMember) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = voteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await qaService.voteAnswer(
      req.params.messageId,
      req.params.threadId,
      req.user!.userId,
      parsed.data.value,
    );

    if ('error' in result) {
      return res.status(400).json({ code: result.error });
    }

    res.json(result);
  });

  // ── PUT /questions/:threadId/accept/:messageId — Accept answer ─────────
  router.put('/questions/:threadId/accept/:messageId', auth, async (req, res) => {
    const result = await qaService.acceptAnswer(
      req.params.threadId,
      req.params.messageId,
      req.user!.userId,
    );

    if ('error' in result) {
      if (result.error === 'FORBIDDEN') return res.status(403).json({ code: result.error });
      return res.status(404).json({ code: result.error });
    }

    res.json(result);
  });

  // ── DELETE /questions/:threadId/accept — Unaccept answer ───────────────
  router.delete('/questions/:threadId/accept', auth, async (req, res) => {
    const result = await qaService.unacceptAnswer(req.params.threadId, req.user!.userId);

    if ('error' in result) {
      if (result.error === 'FORBIDDEN') return res.status(403).json({ code: result.error });
      return res.status(404).json({ code: result.error });
    }

    res.json(result);
  });

  return router;
}
