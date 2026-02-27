import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { messageRateLimiter, pollVoteRateLimiter } from '../../middleware/rate-limiter.js';
import { createMessagesService } from './messages.service.js';
import { createChannelsService } from '../channels/channels.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { createThreadsService } from '../threads/threads.service.js';
import { createRelationshipsService } from '../relationships/relationships.service.js';
import {
  createMessageSchema,
  updateMessageSchema,
  getMessagesSchema,
  createScheduledMessageSchema,
} from './messages.schemas.js';
import { messages, dmRecipients, relationships, messageReactionUsers } from '@gratonite/db';
import { and, eq, or } from 'drizzle-orm';
import { createLinkPreviewService } from './link-preview.service.js';
import { createAutoModService } from '../automod/automod.service.js';
import { createAnalyticsService } from '../analytics/analytics.service.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';
export function messagesRouter(ctx: AppContext): Router {
  const router = Router();
  const messagesService = createMessagesService(ctx);
  const channelsService = createChannelsService(ctx);
  const guildsService = createGuildsService(ctx);
  const threadsService = createThreadsService(ctx);
  const linkPreviewService = createLinkPreviewService(ctx);
  const autoModService = createAutoModService(ctx);
  const analyticsService = createAnalyticsService(ctx);
  const auth = requireAuth(ctx);
  const relService = createRelationshipsService(ctx);

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

  async function ensureDmNotBlocked(channelId: string, senderId: string) {
    const recipients = await ctx.db
      .select({ userId: dmRecipients.userId })
      .from(dmRecipients)
      .where(eq(dmRecipients.channelId, channelId));

    const otherIds = recipients
      .map((row) => String(row.userId))
      .filter((id) => id !== senderId);
    if (otherIds.length === 0) return null;

    for (const otherId of otherIds) {
      const blockedByOther = await relService.isBlocked(senderId, otherId);
      const blockedBySender = await relService.isBlocked(otherId, senderId);
      if (blockedByOther || blockedBySender) {
        return { code: 'BLOCKED', message: 'Messages cannot be sent because one user has blocked the other.' as const };
      }
    }

    return null;
  }

  async function emitDmReactionEvent(
    channelId: string,
    actorUserId: string,
    eventName: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE',
    payload: {
      messageId: string;
      channelId: string;
      userId: string;
      emoji: { id: null; name: string };
      burst?: boolean;
    },
  ) {
    const recipients = await ctx.db
      .select({ userId: dmRecipients.userId })
      .from(dmRecipients)
      .where(eq(dmRecipients.channelId, channelId));

    for (const recipient of recipients) {
      const recipientId = String(recipient.userId);
      if (recipientId === actorUserId) {
        ctx.io.to(`user:${recipientId}`).emit(eventName, payload);
        continue;
      }
      const blockedByRecipient = await relService.isBlocked(actorUserId, recipientId);
      const blockedByActor = await relService.isBlocked(recipientId, actorUserId);
      if (blockedByRecipient || blockedByActor) continue;
      ctx.io.to(`user:${recipientId}`).emit(eventName, payload);
    }
  }

  // Helper: check the caller has access to the channel
  async function checkChannelAccess(channelId: string, userId: string) {
    const channel = await channelsService.getChannel(channelId);
    if (!channel) {
      const [dmMembership] = await ctx.db
        .select({ channelId: dmRecipients.channelId })
        .from(dmRecipients)
        .where(and(eq(dmRecipients.channelId, channelId), eq(dmRecipients.userId, userId)))
        .limit(1);
      if (dmMembership) {
        return { id: channelId, guildId: null, type: 'DM' } as any;
      }

      const thread = await threadsService.getThread(channelId);
      if (!thread) return null;
      const isMember = await guildsService.isMember(thread.guildId, userId);
      if (!isMember) return null;

      if (thread.type === 'private') {
        const isThreadMember = await threadsService.isThreadMember(thread.id, userId);
        if (!isThreadMember && thread.ownerId !== userId) return null;
      }

      return { id: thread.id, guildId: thread.guildId } as any;
    }

    if (!channel.guildId && ['DM', 'GROUP_DM', 'dm', 'group_dm'].includes(String(channel.type))) {
      const [dmMembership] = await ctx.db
        .select({ channelId: dmRecipients.channelId })
        .from(dmRecipients)
        .where(and(eq(dmRecipients.channelId, channelId), eq(dmRecipients.userId, userId)))
        .limit(1);
      if (!dmMembership) return null;
    }

    if (channel.guildId) {
      const isMember = await guildsService.isMember(channel.guildId, userId);
      if (!isMember) return null;
      const canView = await channelsService.canAccessChannel(channel.id, userId);
      if (!canView) return null;
    }
    return channel;
  }

  async function getPollMessage(channelId: string, pollId: string) {
    const [pollMessage] = await ctx.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.pollId, pollId)))
      .limit(1);
    return pollMessage ?? null;
  }

  async function isGuildOwner(guildId: string | null, userId: string) {
    if (!guildId) return false;
    const guild = await guildsService.getGuild(guildId);
    return guild?.ownerId === userId;
  }

  // ── Get messages ─────────────────────────────────────────────────────────

  router.get('/channels/:channelId/messages', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const parsed = getMessagesSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const msgs = await messagesService.getMessages(channelId, parsed.data);
    const blockedIds = await getBlockedUserIdsForViewer(req.user!.userId);
    res.json(msgs.filter((msg) => !blockedIds.has(String(msg.authorId))));
  });

  // ── Get single message ───────────────────────────────────────────────────

  router.get('/channels/:channelId/messages/:messageId', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const message = await messagesService.getMessage(req.params.messageId);
    if (!message || message.channelId !== channelId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    const blockedIds = await getBlockedUserIdsForViewer(req.user!.userId);
    if (blockedIds.has(String(message.authorId))) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    res.json(message);
  });

  // ── Send message ─────────────────────────────────────────────────────────

  router.post('/channels/:channelId/messages', auth, messageRateLimiter, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    if (!channel.guildId && ['DM', 'GROUP_DM', 'dm', 'group_dm'].includes(String(channel.type))) {
      const blocked = await ensureDmNotBlocked(channelId, req.user!.userId);
      if (blocked) {
        return res.status(403).json(blocked);
      }
    }

    const parsed = createMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    // Auto-moderation check (guild messages only)
    if (channel.guildId && parsed.data.content) {
      const mentionCount = (parsed.data.content.match(/<@!?\d+>/g) ?? []).length;
      const autoModResult = await autoModService.checkMessage(
        channel.guildId,
        channelId,
        req.user!.userId,
        [], // role IDs — simplified for now
        parsed.data.content,
        mentionCount,
      );
      if (autoModResult.blocked) {
        return res.status(403).json({
          code: 'AUTO_MODERATION_BLOCKED',
          matchedRule: autoModResult.rule?.name,
        });
      }
    }

    const message = await messagesService.createMessage(
      channelId,
      req.user!.userId,
      channel.guildId ?? null,
      parsed.data,
    );

    if (message && typeof message === 'object' && 'error' in message) {
      return res.status(400).json({ code: message.error });
    }

    // Broadcast via Socket.IO
    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'MESSAGE_CREATE',
        message as any,
      );
    } else {
      await emitRoomWithIntent(
        ctx.io,
        `channel:${channelId}`,
        GatewayIntents.DIRECT_MESSAGES,
        'MESSAGE_CREATE',
        message as any,
      );
    }

    // Publish to Redis for cross-server fanout
    await ctx.redis.publish(
      `channel:${channelId}:messages`,
      JSON.stringify({ type: 'MESSAGE_CREATE', data: message }),
    );

    res.status(201).json(message);

    // Fire-and-forget: analytics tracking
    if (channel.guildId) {
      analyticsService.trackMessage(channel.guildId, channelId, req.user!.userId).catch(() => {});
    }

    // Fire-and-forget: process link previews asynchronously
    const content = (message as any).content;
    if (content && typeof content === 'string' && content.includes('http')) {
      linkPreviewService.processMessageLinks(String((message as any).id), content).catch(() => {});
    }
  });

  // ── Polls ───────────────────────────────────────────────────────────────

  router.put(
    '/channels/:channelId/polls/:pollId/votes/:answerId',
    auth,
    pollVoteRateLimiter,
    async (req, res) => {
      const channelId = req.params.channelId;
      const channel = await checkChannelAccess(channelId, req.user!.userId);
      if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

      const pollMessage = await getPollMessage(channelId, req.params.pollId);
      if (!pollMessage) return res.status(404).json({ code: 'NOT_FOUND' });

      const result = await messagesService.addPollVote(
        req.params.pollId,
        req.params.answerId,
        req.user!.userId,
      );

      if (result && typeof result === 'object' && 'error' in result) {
        return res.status(400).json({ code: result.error });
      }

      if (channel.guildId) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${channel.guildId}`,
          GatewayIntents.GUILD_MESSAGES,
          'POLL_VOTE_ADD',
          {
            pollId: req.params.pollId,
            answerId: req.params.answerId,
            userId: req.user!.userId,
          },
        );
      }

      res.status(204).send();
    },
  );

  router.delete(
    '/channels/:channelId/polls/:pollId/votes/:answerId',
    auth,
    pollVoteRateLimiter,
    async (req, res) => {
      const channelId = req.params.channelId;
      const channel = await checkChannelAccess(channelId, req.user!.userId);
      if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

      const pollMessage = await getPollMessage(channelId, req.params.pollId);
      if (!pollMessage) return res.status(404).json({ code: 'NOT_FOUND' });

      await messagesService.removePollVote(
        req.params.pollId,
        req.params.answerId,
        req.user!.userId,
      );

      if (channel.guildId) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${channel.guildId}`,
          GatewayIntents.GUILD_MESSAGES,
          'POLL_VOTE_REMOVE',
          {
            pollId: req.params.pollId,
            answerId: req.params.answerId,
            userId: req.user!.userId,
          },
        );
      }

      res.status(204).send();
    },
  );

  router.get('/channels/:channelId/polls/:pollId/votes', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const pollMessage = await getPollMessage(channelId, req.params.pollId);
    if (!pollMessage) return res.status(404).json({ code: 'NOT_FOUND' });

    const votes = await messagesService.getPollVotes(req.params.pollId);
    res.json(votes);
  });

  router.post('/channels/:channelId/polls/:pollId/finalize', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const pollMessage = await getPollMessage(channelId, req.params.pollId);
    if (!pollMessage) return res.status(404).json({ code: 'NOT_FOUND' });

    let isAdmin = false;
    if (channel.guildId) {
      const guild = await guildsService.getGuild(channel.guildId);
      isAdmin = guild?.ownerId === req.user!.userId;
    }

    if (pollMessage.authorId !== req.user!.userId && !isAdmin) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const updated = await messagesService.finalizePoll(req.params.pollId);
    if (!updated) return res.status(404).json({ code: 'NOT_FOUND' });

    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'POLL_FINALIZE',
        {
          pollId: req.params.pollId,
        },
      );
    }

    res.json(updated);
  });

  // ── Scheduled messages ─────────────────────────────────────────────────-

  router.post('/channels/:channelId/scheduled-messages', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const parsed = createScheduledMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const scheduled = await messagesService.createScheduledMessage(
      channelId,
      req.user!.userId,
      parsed.data,
    );

    if (scheduled && typeof scheduled === 'object' && 'error' in scheduled) {
      return res.status(400).json({ code: scheduled.error });
    }

    res.status(201).json(scheduled);
  });

  router.get('/channels/:channelId/scheduled-messages', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const isAdmin = await isGuildOwner(channel.guildId ?? null, req.user!.userId);
    const scheduled = await messagesService.getScheduledMessages(channelId, req.user!.userId, isAdmin);
    res.json(scheduled);
  });

  router.delete('/channels/:channelId/scheduled-messages/:scheduledMessageId', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const isAdmin = await isGuildOwner(channel.guildId ?? null, req.user!.userId);
    const cancelled = await messagesService.cancelScheduledMessage(
      req.params.scheduledMessageId,
      req.user!.userId,
      isAdmin,
    );

    if (!cancelled) return res.status(404).json({ code: 'NOT_FOUND' });

    res.status(204).send();
  });

  // ── Edit message ─────────────────────────────────────────────────────────

  router.patch('/channels/:channelId/messages/:messageId', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const parsed = updateMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await messagesService.updateMessage(
      req.params.messageId,
      req.user!.userId,
      parsed.data,
    );

    if (!result) return res.status(404).json({ code: 'NOT_FOUND' });
    if ('error' in result) return res.status(403).json({ code: result.error });

    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'MESSAGE_UPDATE',
        result as any,
      );
    } else {
      await emitRoomWithIntent(
        ctx.io,
        `channel:${channelId}`,
        GatewayIntents.DIRECT_MESSAGES,
        'MESSAGE_UPDATE',
        result as any,
      );
    }

    res.json(result);
  });

  // ── Delete message ───────────────────────────────────────────────────────

  router.delete('/channels/:channelId/messages/:messageId', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    // Check if user is message author or server owner (admin)
    let isAdmin = false;
    if (channel.guildId) {
      const guild = await guildsService.getGuild(channel.guildId);
      isAdmin = guild?.ownerId === req.user!.userId;
    }

    const result = await messagesService.deleteMessage(
      req.params.messageId,
      req.user!.userId,
      isAdmin,
    );

    if (!result) return res.status(404).json({ code: 'NOT_FOUND' });
    if ('error' in result) return res.status(403).json({ code: result.error });

    const deleteEvent = {
      id: req.params.messageId,
      channelId,
      guildId: channel.guildId ?? undefined,
    };

    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'MESSAGE_DELETE',
        deleteEvent,
      );
    } else {
      await emitRoomWithIntent(
        ctx.io,
        `channel:${channelId}`,
        GatewayIntents.DIRECT_MESSAGES,
        'MESSAGE_DELETE',
        deleteEvent,
      );
    }

    res.status(204).send();
  });

  // ── Reactions ────────────────────────────────────────────────────────────

  // Add reaction
  router.put('/channels/:channelId/messages/:messageId/reactions/:emoji/@me', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });
    if (!channel.guildId && ['DM', 'GROUP_DM', 'dm', 'group_dm'].includes(String(channel.type))) {
      const blocked = await ensureDmNotBlocked(channelId, req.user!.userId);
      if (blocked) return res.status(403).json(blocked);
    }

    const emojiName = decodeURIComponent(req.params.emoji);
    const added = await messagesService.addReaction(
      req.params.messageId,
      req.user!.userId,
      emojiName,
    );

    if (added) {
      if (channel.guildId) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${channel.guildId}`,
          GatewayIntents.GUILD_MESSAGES,
          'MESSAGE_REACTION_ADD',
          {
            messageId: req.params.messageId,
            channelId,
            userId: req.user!.userId,
            emoji: { id: null, name: emojiName },
            burst: false,
          },
        );
      } else {
        await emitDmReactionEvent(channelId, req.user!.userId, 'MESSAGE_REACTION_ADD', {
          messageId: req.params.messageId,
          channelId,
          userId: req.user!.userId,
          emoji: { id: null, name: emojiName },
          burst: false,
        });
      }
    }

    res.status(204).send();
  });

  // Remove reaction
  router.delete('/channels/:channelId/messages/:messageId/reactions/:emoji/@me', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });
    if (!channel.guildId && ['DM', 'GROUP_DM', 'dm', 'group_dm'].includes(String(channel.type))) {
      const blocked = await ensureDmNotBlocked(channelId, req.user!.userId);
      if (blocked) return res.status(403).json(blocked);
    }

    const emojiName = decodeURIComponent(req.params.emoji);
    const removed = await messagesService.removeReaction(
      req.params.messageId,
      req.user!.userId,
      emojiName,
    );
    if (!removed) return res.status(204).send();

    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'MESSAGE_REACTION_REMOVE',
        {
          messageId: req.params.messageId,
          channelId,
          userId: req.user!.userId,
          emoji: { id: null, name: emojiName },
        },
      );
    } else {
      await emitDmReactionEvent(channelId, req.user!.userId, 'MESSAGE_REACTION_REMOVE', {
        messageId: req.params.messageId,
        channelId,
        userId: req.user!.userId,
        emoji: { id: null, name: emojiName },
      });
    }

    res.status(204).send();
  });

  // Get reactions for a message
  router.get('/channels/:channelId/messages/:messageId/reactions', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    if (!channel.guildId && ['DM', 'GROUP_DM', 'dm', 'group_dm'].includes(String((channel as any).type))) {
      const blockedIds = await getBlockedUserIdsForViewer(req.user!.userId);
      const rows = await ctx.db
        .select({
          messageId: messageReactionUsers.messageId,
          emojiId: messageReactionUsers.emojiId,
          emojiName: messageReactionUsers.emojiName,
          userId: messageReactionUsers.userId,
          burst: messageReactionUsers.burst,
        })
        .from(messageReactionUsers)
        .where(eq(messageReactionUsers.messageId, req.params.messageId));

      const aggregates = new Map<string, { messageId: string; emojiId: string | null; emojiName: string; count: number; burstCount: number }>();
      for (const row of rows) {
        if (blockedIds.has(String(row.userId))) continue;
        const key = `${row.emojiId ?? ''}:${row.emojiName}`;
        const existing = aggregates.get(key);
        if (existing) {
          existing.count += 1;
          if (row.burst) existing.burstCount += 1;
          continue;
        }
        aggregates.set(key, {
          messageId: String(row.messageId),
          emojiId: row.emojiId ? String(row.emojiId) : null,
          emojiName: String(row.emojiName),
          count: 1,
          burstCount: row.burst ? 1 : 0,
        });
      }
      return res.json(Array.from(aggregates.values()));
    }

    const reactions = await messagesService.getReactions(req.params.messageId);
    res.json(reactions);
  });

  // ── Pins ─────────────────────────────────────────────────────────────────

  // Get pinned messages
  router.get('/channels/:channelId/pins', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    const pins = await messagesService.getPins(channelId);
    const blockedIds = await getBlockedUserIdsForViewer(req.user!.userId);
    res.json(pins.filter((msg) => !blockedIds.has(String((msg as any).authorId))));
  });

  // Pin a message
  router.put('/channels/:channelId/pins/:messageId', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    // TODO: Check MANAGE_MESSAGES permission
    const result = await messagesService.pinMessage(channelId, req.params.messageId, req.user!.userId);

    if (result && typeof result === 'object' && 'error' in result) {
      return res.status(400).json({ code: result.error });
    }

    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'CHANNEL_PINS_UPDATE',
        {
          channelId,
          lastPinTimestamp: new Date().toISOString(),
        },
      );
    }

    res.status(204).send();
  });

  // Unpin a message
  router.delete('/channels/:channelId/pins/:messageId', auth, async (req, res) => {
    const channelId = req.params.channelId;
    const channel = await checkChannelAccess(channelId, req.user!.userId);
    if (!channel) return res.status(403).json({ code: 'FORBIDDEN' });

    await messagesService.unpinMessage(channelId, req.params.messageId);

    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'CHANNEL_PINS_UPDATE',
        {
          channelId,
          lastPinTimestamp: new Date().toISOString(),
        },
      );
    }

    res.status(204).send();
  });

  return router;
}
