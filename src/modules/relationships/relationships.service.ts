import { eq, and, or, inArray, sql } from 'drizzle-orm';
import { relationships, dmChannels, dmRecipients, users, userProfiles, channels } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';

export function createRelationshipsService(ctx: AppContext) {
  async function ensureDmChannelRow(channel: { id: string; type: string; name?: string | null }) {
    await ctx.db
      .insert(channels)
      .values({
        id: channel.id,
        type: channel.type === 'group_dm' ? 'GROUP_DM' : 'DM',
        name: channel.name ?? null,
      })
      .onConflictDoNothing();
  }
  // ── Friends ──────────────────────────────────────────────────────────────

  async function sendFriendRequest(fromUserId: string, toUserId: string) {
    if (fromUserId === toUserId) return { error: 'CANNOT_SELF_FRIEND' as const };

    // Check if already friends or blocked
    const [existing] = await ctx.db
      .select()
      .from(relationships)
      .where(
        and(eq(relationships.userId, fromUserId), eq(relationships.targetId, toUserId)),
      )
      .limit(1);

    if (existing) {
      if (existing.type === 'friend') return { error: 'ALREADY_FRIENDS' as const };
      if (existing.type === 'blocked') return { error: 'USER_BLOCKED' as const };
      if (existing.type === 'pending_outgoing') return { error: 'ALREADY_PENDING' as const };
    }

    // Check if they already sent us a request — auto-accept
    const [incoming] = await ctx.db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.userId, toUserId),
          eq(relationships.targetId, fromUserId),
          eq(relationships.type, 'pending_outgoing'),
        ),
      )
      .limit(1);

    if (incoming) {
      // Auto-accept: both sides become friends
      await ctx.db
        .update(relationships)
        .set({ type: 'friend' })
        .where(
          and(eq(relationships.userId, toUserId), eq(relationships.targetId, fromUserId)),
        );

      // Delete any existing pending_incoming record on our side
      await ctx.db
        .delete(relationships)
        .where(
          and(eq(relationships.userId, fromUserId), eq(relationships.targetId, toUserId)),
        );

      await ctx.db.insert(relationships).values({
        userId: fromUserId,
        targetId: toUserId,
        type: 'friend',
      });

      return { accepted: true };
    }

    // Check friend limit (1000)
    const [count] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(relationships)
      .where(and(eq(relationships.userId, fromUserId), eq(relationships.type, 'friend')));

    if ((count?.count ?? 0) >= 1000) {
      return { error: 'FRIEND_LIMIT_REACHED' as const };
    }

    // Create pending request
    await ctx.db.insert(relationships).values({
      userId: fromUserId,
      targetId: toUserId,
      type: 'pending_outgoing',
    });

    await ctx.db.insert(relationships).values({
      userId: toUserId,
      targetId: fromUserId,
      type: 'pending_incoming',
    });

    return { sent: true };
  }

  async function acceptFriendRequest(userId: string, fromUserId: string) {
    // Verify pending_incoming exists
    const [incoming] = await ctx.db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.userId, userId),
          eq(relationships.targetId, fromUserId),
          eq(relationships.type, 'pending_incoming'),
        ),
      )
      .limit(1);

    if (!incoming) return { error: 'NO_PENDING_REQUEST' as const };

    // Update both sides to friend
    await ctx.db
      .update(relationships)
      .set({ type: 'friend' })
      .where(
        and(eq(relationships.userId, userId), eq(relationships.targetId, fromUserId)),
      );

    await ctx.db
      .update(relationships)
      .set({ type: 'friend' })
      .where(
        and(eq(relationships.userId, fromUserId), eq(relationships.targetId, userId)),
      );

    return { accepted: true };
  }

  async function removeFriend(userId: string, targetId: string) {
    await ctx.db
      .delete(relationships)
      .where(and(eq(relationships.userId, userId), eq(relationships.targetId, targetId)));

    await ctx.db
      .delete(relationships)
      .where(and(eq(relationships.userId, targetId), eq(relationships.targetId, userId)));
  }

  async function blockUser(userId: string, targetId: string) {
    // Remove any existing relationship
    await ctx.db
      .delete(relationships)
      .where(and(eq(relationships.userId, userId), eq(relationships.targetId, targetId)));

    // Also clean up the other side's pending/friend
    await ctx.db
      .delete(relationships)
      .where(and(eq(relationships.userId, targetId), eq(relationships.targetId, userId)));

    // Create block
    await ctx.db.insert(relationships).values({
      userId,
      targetId,
      type: 'blocked',
    });
  }

  async function unblockUser(userId: string, targetId: string) {
    await ctx.db
      .delete(relationships)
      .where(
        and(
          eq(relationships.userId, userId),
          eq(relationships.targetId, targetId),
          eq(relationships.type, 'blocked'),
        ),
      );
  }

  async function getRelationships(userId: string) {
    return ctx.db
      .select()
      .from(relationships)
      .where(eq(relationships.userId, userId));
  }

  async function isBlocked(userId: string, targetId: string) {
    const [block] = await ctx.db
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.userId, targetId),
          eq(relationships.targetId, userId),
          eq(relationships.type, 'blocked'),
        ),
      )
      .limit(1);
    return !!block;
  }

  // ── DMs ──────────────────────────────────────────────────────────────────

  async function getOrCreateDmChannel(userId: string, targetId: string) {
    // Find existing DM channel between these two users
    const userDms = await ctx.db
      .select({ channelId: dmRecipients.channelId })
      .from(dmRecipients)
      .where(eq(dmRecipients.userId, userId));

    for (const dm of userDms) {
      const [otherUser] = await ctx.db
        .select({ userId: dmRecipients.userId })
        .from(dmRecipients)
        .where(
          and(
            eq(dmRecipients.channelId, dm.channelId),
            eq(dmRecipients.userId, targetId),
          ),
        )
        .limit(1);

      if (otherUser) {
        // Found existing DM channel
        const [channel] = await ctx.db
          .select()
          .from(dmChannels)
          .where(and(eq(dmChannels.id, dm.channelId), eq(dmChannels.type, 'dm')))
          .limit(1);

        if (channel) {
          await ensureDmChannelRow(channel as any);
          return channel;
        }
      }
    }

    // Create new DM channel
    const channelId = generateId();

    const [channel] = await ctx.db
      .insert(dmChannels)
      .values({ id: channelId, type: 'dm' })
      .returning();

    await ctx.db.insert(dmRecipients).values([
      { channelId, userId },
      { channelId, userId: targetId },
    ]);

    await ensureDmChannelRow(channel as any);

    return channel;
  }

  async function getUserDmChannels(userId: string) {
    const recipientEntries = await ctx.db
      .select({ channelId: dmRecipients.channelId })
      .from(dmRecipients)
      .where(eq(dmRecipients.userId, userId));

    if (recipientEntries.length === 0) return [];

    const channelIds = recipientEntries.map((r) => r.channelId);
    const channelsList = await ctx.db
      .select()
      .from(dmChannels)
      .where(inArray(dmChannels.id, channelIds));

    const recipients = await ctx.db
      .select({ channelId: dmRecipients.channelId, userId: dmRecipients.userId })
      .from(dmRecipients)
      .where(inArray(dmRecipients.channelId, channelIds));

    const otherRecipientMap = new Map<string, string>();
    const channelRecipientIds = new Map<string, string[]>();
    for (const row of recipients) {
      // Build recipientIds list for every channel (all members including caller)
      const existing = channelRecipientIds.get(row.channelId) ?? [];
      existing.push(row.userId.toString());
      channelRecipientIds.set(row.channelId, existing);

      if (row.userId.toString() === userId) continue;
      if (!otherRecipientMap.has(row.channelId)) {
        otherRecipientMap.set(row.channelId, row.userId.toString());
      }
    }

    for (const dmChannel of channelsList) {
      await ensureDmChannelRow(dmChannel as any);
    }

    return channelsList.map((dm) => ({
      ...dm,
      otherUserId: dm.type === 'dm' ? (otherRecipientMap.get(dm.id) ?? null) : null,
      recipientIds: channelRecipientIds.get(dm.id) ?? [],
    }));
  }

  async function createGroupDm(ownerId: string, recipientIds: string[], name?: string) {
    if (recipientIds.length > 9) return { error: 'GROUP_DM_LIMIT' as const }; // 10 including owner

    const channelId = generateId();

    const [channel] = await ctx.db
      .insert(dmChannels)
      .values({
        id: channelId,
        type: 'group_dm',
        ownerId,
        name: name ?? null,
      })
      .returning();

    const allRecipients = [ownerId, ...recipientIds];
    await ctx.db.insert(dmRecipients).values(
      allRecipients.map((userId) => ({ channelId, userId })),
    );

    await ensureDmChannelRow(channel as any);

    return channel;
  }

  return {
    sendFriendRequest,
    acceptFriendRequest,
    removeFriend,
    blockUser,
    unblockUser,
    getRelationships,
    isBlocked,
    getOrCreateDmChannel,
    getUserDmChannels,
    createGroupDm,
  };
}

export type RelationshipsService = ReturnType<typeof createRelationshipsService>;
