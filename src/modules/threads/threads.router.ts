import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { createChannelsService } from '../channels/channels.service.js';
import { createThreadsService } from './threads.service.js';
import { createRelationshipsService } from '../relationships/relationships.service.js';
import { createThreadSchema, updateThreadSchema } from './threads.schemas.js';
import { messages, relationships } from '@gratonite/db';
import { and, desc, eq, or } from 'drizzle-orm';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

export function threadsRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const guildsService = createGuildsService(ctx);
  const channelsService = createChannelsService(ctx);
  const threadsService = createThreadsService(ctx);
  const relService = createRelationshipsService(ctx);

  async function ensureChannelAccess(channelId: string, userId: string) {
    const channel = await channelsService.getChannel(channelId);
    if (!channel) return null;
    if (channel.guildId) {
      const isMember = await guildsService.isMember(channel.guildId, userId);
      if (!isMember) return null;
    }
    return channel;
  }

  async function ensureThreadAccess(threadId: string, userId: string) {
    const thread = await threadsService.getThread(threadId);
    if (!thread) return null;
    const isMember = await guildsService.isMember(thread.guildId, userId);
    if (!isMember) return null;

    if (thread.type === 'private') {
      const isThreadMember = await threadsService.isThreadMember(threadId, userId);
      if (!isThreadMember && thread.ownerId !== userId) return null;
    }

    return thread;
  }

  async function getBlockedUserIdsForViewer(viewerId: string): Promise<Set<string>> {
    const rows = await ctx.db
      .select({ userId: relationships.userId, targetId: relationships.targetId })
      .from(relationships)
      .where(
        and(
          eq(relationships.type, 'blocked'),
          or(eq(relationships.userId, viewerId), eq(relationships.targetId, viewerId)),
        ),
      );
    const blocked = new Set<string>();
    for (const row of rows) {
      const a = String(row.userId);
      const b = String(row.targetId);
      if (a === viewerId) blocked.add(b);
      if (b === viewerId) blocked.add(a);
    }
    return blocked;
  }

  // ── Create thread ───────────────────────────────────────────────────────

  router.post('/channels/:channelId/threads', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await ensureChannelAccess(channelId, req.user!.userId);
    if (!channel || !channel.guildId) return res.status(403).json({ code: 'FORBIDDEN' });

    const parsed = createThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await threadsService.createThread(
      channelId,
      channel.guildId,
      req.user!.userId,
      parsed.data,
    );

    if (result && typeof result === 'object' && 'error' in result) {
      return res.status(400).json({ code: result.error });
    }

    const thread = result as any;
    await emitRoomWithIntent(
      ctx.io,
      `guild:${channel.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'THREAD_CREATE',
      thread,
    );

    if (parsed.data.message) {
      const [starter] = await ctx.db
        .select()
        .from(messages)
        .where(eq(messages.channelId, thread.id))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (starter) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${channel.guildId}`,
          GatewayIntents.GUILD_MESSAGES,
          'MESSAGE_CREATE',
          starter as any,
        );
      }
    }

    res.status(201).json(thread);
  });

  // ── List threads for channel ────────────────────────────────────────────

  router.get('/channels/:channelId/threads', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await ensureChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const threads = await threadsService.getThreadsForChannel(channelId, false);
    res.json(threads);
  });

  router.get('/channels/:channelId/threads/archived', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await ensureChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const threads = await threadsService.getThreadsForChannel(channelId, true);
    res.json(threads);
  });

  // ── Get thread ──────────────────────────────────────────────────────────

  router.get('/threads/:threadId', auth, async (req, res) => {
    const thread = await ensureThreadAccess(req.params.threadId, req.user!.userId);
    if (!thread) return res.status(403).json({ code: 'FORBIDDEN' });
    res.json(thread);
  });

  // ── Update thread ───────────────────────────────────────────────────────

  router.patch('/threads/:threadId', auth, async (req, res) => {
    const thread = await ensureThreadAccess(req.params.threadId, req.user!.userId);
    if (!thread) return res.status(403).json({ code: 'FORBIDDEN' });

    if (thread.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the thread owner can update this thread' });
    }

    const parsed = updateThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await threadsService.updateThread(req.params.threadId, parsed.data);
    if (!updated) return res.status(404).json({ code: 'NOT_FOUND' });

    await emitRoomWithIntent(
      ctx.io,
      `guild:${thread.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'THREAD_UPDATE',
      updated as any,
    );
    res.json(updated);
  });

  // ── Delete thread ───────────────────────────────────────────────────────

  router.delete('/threads/:threadId', auth, async (req, res) => {
    const thread = await ensureThreadAccess(req.params.threadId, req.user!.userId);
    if (!thread) return res.status(403).json({ code: 'FORBIDDEN' });

    if (thread.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the thread owner can delete this thread' });
    }

    await threadsService.deleteThread(req.params.threadId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${thread.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'THREAD_DELETE',
      {
        id: String(thread.id),
        parentId: String(thread.parentId),
        guildId: String(thread.guildId),
      },
    );

    res.status(204).send();
  });

  // ── Thread members ──────────────────────────────────────────────────────

  router.get('/threads/:threadId/members', auth, async (req, res) => {
    const thread = await ensureThreadAccess(req.params.threadId, req.user!.userId);
    if (!thread) return res.status(403).json({ code: 'FORBIDDEN' });

    const members = await threadsService.getThreadMembers(req.params.threadId);
    const blockedIds = await getBlockedUserIdsForViewer(req.user!.userId);
    res.json(members.filter((member: any) => !blockedIds.has(String(member.userId ?? member.id))));
  });

  router.put('/threads/:threadId/members/@me', auth, async (req, res) => {
    const thread = await ensureThreadAccess(req.params.threadId, req.user!.userId);
    if (!thread) return res.status(403).json({ code: 'FORBIDDEN' });

    if (thread.type === 'private' && !thread.invitable && thread.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await threadsService.joinThread(req.params.threadId, req.user!.userId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${thread.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'THREAD_MEMBER_ADD',
      {
        threadId: String(thread.id),
        userId: String(req.user!.userId),
      },
    );

    res.status(204).send();
  });

  router.delete('/threads/:threadId/members/@me', auth, async (req, res) => {
    const thread = await ensureThreadAccess(req.params.threadId, req.user!.userId);
    if (!thread) return res.status(403).json({ code: 'FORBIDDEN' });

    await threadsService.leaveThread(req.params.threadId, req.user!.userId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${thread.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'THREAD_MEMBER_REMOVE',
      {
        threadId: String(thread.id),
        userId: String(req.user!.userId),
      },
    );

    res.status(204).send();
  });

  return router;
}
