import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../lib/context.js';
import { eq, desc } from 'drizzle-orm';
import { users, messages } from '@gratonite/db';
import { requireAuth } from '../../middleware/auth.js';
import { createRelationshipsService } from './relationships.service.js';

const sendRequestSchema = z.object({
  userId: z.string(),
});

const createGroupDmSchema = z.object({
  recipientIds: z.array(z.string()).min(1).max(9),
  name: z.string().min(1).max(100).optional(),
});

export function relationshipsRouter(ctx: AppContext): Router {
  const router = Router();
  const relService = createRelationshipsService(ctx);
  const auth = requireAuth(ctx);

  async function resolveUserId(input: string): Promise<string | null> {
    if (/^\d+$/.test(input)) return input;
    const username = input.trim().toLowerCase();
    const [user] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return user ? user.id.toString() : null;
  }

  // ── Relationships ────────────────────────────────────────────────────────

  // Get all relationships (friends, pending, blocked)
  router.get('/', auth, async (req, res) => {
    const rels = await relService.getRelationships(req.user!.userId);
    res.json(rels);
  });

  // Send friend request
  router.post('/friends', auth, async (req, res) => {
    const parsed = sendRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const targetId = await resolveUserId(parsed.data.userId);
    if (!targetId) {
      return res.status(404).json({ code: 'USER_NOT_FOUND' });
    }

    const result = await relService.sendFriendRequest(
      req.user!.userId,
      targetId,
    );

    if ('error' in result) {
      const statusMap: Record<string, number> = {
        CANNOT_SELF_FRIEND: 400,
        ALREADY_FRIENDS: 400,
        USER_BLOCKED: 403,
        ALREADY_PENDING: 400,
        FRIEND_LIMIT_REACHED: 400,
      };
      return res.status(statusMap[result.error] ?? 400).json({ code: result.error });
    }

    if ('accepted' in result) {
      // Notify both users of new friendship
      ctx.io.to(`user:${req.user!.userId}`).emit('USER_UPDATE', { userId: req.user!.userId, friendAdded: targetId } as any);
      ctx.io.to(`user:${targetId}`).emit('USER_UPDATE', { userId: targetId, friendAdded: req.user!.userId } as any);
    }
    if ('sent' in result) {
      ctx.io.to(`user:${req.user!.userId}`).emit('USER_UPDATE', { userId: req.user!.userId, relationshipChanged: true } as any);
      ctx.io.to(`user:${targetId}`).emit('USER_UPDATE', { userId: targetId, relationshipChanged: true } as any);
    }

    res.status(201).json(result);
  });

  // Accept friend request
  router.put('/friends/:userId', auth, async (req, res) => {
    const fromUserId = req.params.userId;
    const result = await relService.acceptFriendRequest(
      req.user!.userId,
      fromUserId,
    );

    if ('error' in result) {
      return res.status(404).json({ code: result.error });
    }

    ctx.io.to(`user:${req.user!.userId}`).emit('USER_UPDATE', { userId: req.user!.userId, relationshipChanged: true } as any);
    ctx.io.to(`user:${fromUserId}`).emit('USER_UPDATE', { userId: fromUserId, relationshipChanged: true } as any);

    res.json(result);
  });

  // Remove friend / decline request
  router.delete('/friends/:userId', auth, async (req, res) => {
    const targetId = req.params.userId;
    await relService.removeFriend(req.user!.userId, targetId);
    ctx.io.to(`user:${req.user!.userId}`).emit('USER_UPDATE', { userId: req.user!.userId, relationshipChanged: true } as any);
    ctx.io.to(`user:${targetId}`).emit('USER_UPDATE', { userId: targetId, relationshipChanged: true } as any);
    res.status(204).send();
  });

  // Block user
  router.put('/blocks/:userId', auth, async (req, res) => {
    const targetId = req.params.userId;
    await relService.blockUser(req.user!.userId, targetId);
    ctx.io.to(`user:${req.user!.userId}`).emit('USER_UPDATE', { userId: req.user!.userId, relationshipChanged: true } as any);
    ctx.io.to(`user:${targetId}`).emit('USER_UPDATE', { userId: targetId, relationshipChanged: true } as any);
    res.status(204).send();
  });

  // Unblock user
  router.delete('/blocks/:userId', auth, async (req, res) => {
    const targetId = req.params.userId;
    await relService.unblockUser(req.user!.userId, targetId);
    ctx.io.to(`user:${req.user!.userId}`).emit('USER_UPDATE', { userId: req.user!.userId, relationshipChanged: true } as any);
    res.status(204).send();
  });

  // ── DM channels ──────────────────────────────────────────────────────────

  // Get user's DM channels
  router.get('/channels', auth, async (req, res) => {
    const dmChans = await relService.getUserDmChannels(req.user!.userId);

    // Enrich each channel with last message info
    const enriched = await Promise.all(
      dmChans.map(async (ch) => {
        const [lastMsg] = await ctx.db
          .select({
            content: messages.content,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.channelId, ch.id))
          .orderBy(desc(messages.createdAt))
          .limit(1);

        return {
          ...ch,
          lastMessageContent: lastMsg
            ? lastMsg.content.length > 80
              ? lastMsg.content.slice(0, 80)
              : lastMsg.content
            : null,
          lastMessageAt: lastMsg?.createdAt
            ? lastMsg.createdAt.toISOString()
            : null,
        };
      }),
    );

    res.json(enriched);
  });

  // Open DM with user (or get existing)
  router.post('/channels', auth, async (req, res) => {
    const parsed = sendRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const targetId = await resolveUserId(parsed.data.userId);
    if (!targetId) {
      return res.status(404).json({ code: 'USER_NOT_FOUND' });
    }

    // Check if blocked in either direction
    const blockedByTarget = await relService.isBlocked(req.user!.userId, targetId);
    const blockedBySelf = await relService.isBlocked(targetId, req.user!.userId);
    if (blockedByTarget || blockedBySelf) {
      return res.status(403).json({
        code: 'BLOCKED',
        message: 'Cannot open a DM because one user has blocked the other.',
      });
    }

    const channel = await relService.getOrCreateDmChannel(
      req.user!.userId,
      targetId,
    );

    res.json(channel);
  });

  // Create group DM
  router.post('/group-dms', auth, async (req, res) => {
    const parsed = createGroupDmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const uniqueRecipients = [...new Set(parsed.data.recipientIds.map((id) => String(id)))].filter(
      (id) => id !== req.user!.userId,
    );

    for (const recipientId of uniqueRecipients) {
      const blockedByRecipient = await relService.isBlocked(req.user!.userId, recipientId);
      const blockedBySelf = await relService.isBlocked(recipientId, req.user!.userId);
      if (blockedByRecipient || blockedBySelf) {
        return res.status(403).json({
          code: 'BLOCKED',
          message: 'Cannot create a group DM because one user has blocked the other.',
        });
      }
    }

    const result = await relService.createGroupDm(
      req.user!.userId,
      uniqueRecipients,
      parsed.data.name,
    );

    if ('error' in result) {
      return res.status(400).json({ code: result.error });
    }

    res.status(201).json(result);
  });

  return router;
}
