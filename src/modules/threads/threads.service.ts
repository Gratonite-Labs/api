import { and, eq, sql } from 'drizzle-orm';
import { channels, messages, threadMembers, threads } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import type { CreateThreadInput, UpdateThreadInput } from './threads.schemas.js';

const ALLOWED_PARENT_TYPES = new Set([
  'GUILD_TEXT',
  'GUILD_ANNOUNCEMENT',
  'GUILD_FORUM',
  'GUILD_MEDIA',
  'GUILD_WIKI',
  'GUILD_QA',
]);

export function createThreadsService(ctx: AppContext) {
  async function getThread(threadId: string) {
    const [thread] = await ctx.db
      .select()
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    return thread ?? null;
  }

  async function getThreadsForChannel(channelId: string, archived = false) {
    return ctx.db
      .select()
      .from(threads)
      .where(and(eq(threads.parentId, channelId), eq(threads.archived, archived)))
      .orderBy(sql`${threads.pinned} DESC`, sql`${threads.createdAt} DESC`);
  }

  async function getThreadMembers(threadId: string) {
    return ctx.db
      .select()
      .from(threadMembers)
      .where(eq(threadMembers.threadId, threadId));
  }

  async function isThreadMember(threadId: string, userId: string) {
    const [member] = await ctx.db
      .select({ userId: threadMembers.userId })
      .from(threadMembers)
      .where(and(eq(threadMembers.threadId, threadId), eq(threadMembers.userId, userId)))
      .limit(1);
    return !!member;
  }

  async function createThread(
    parentId: string,
    guildId: string,
    ownerId: string,
    input: CreateThreadInput,
  ) {
    const [parent] = await ctx.db
      .select()
      .from(channels)
      .where(eq(channels.id, parentId))
      .limit(1);

    if (!parent || parent.guildId !== guildId) return { error: 'PARENT_NOT_FOUND' as const };
    if (!ALLOWED_PARENT_TYPES.has(parent.type)) return { error: 'INVALID_PARENT' as const };

    const isForum = parent.type === 'GUILD_FORUM';
    if (isForum && !input.message) return { error: 'FORUM_REQUIRES_MESSAGE' as const };

    const availableTags = Array.isArray(parent.availableTags) ? parent.availableTags : [];
    const validTagIds = new Set(availableTags.map((tag: any) => String(tag.id)));
    const appliedTags = (input.appliedTags ?? []).map(String);
    if (isForum && appliedTags.some((tagId) => !validTagIds.has(tagId))) {
      return { error: 'INVALID_TAG' as const };
    }

    const threadId = generateId();
    const autoArchiveDuration =
      input.autoArchiveDuration ?? parent.defaultAutoArchiveDuration ?? 10080;

    const [thread] = await ctx.db
      .insert(threads)
      .values({
        id: threadId,
        parentId,
        guildId,
        ownerId,
        name: input.name,
        type: input.type ?? 'public',
        autoArchiveDuration,
        invitable: input.invitable ?? true,
        appliedTags,
        memberCount: 1,
      })
      .returning();

    await ctx.db.insert(threadMembers).values({ threadId, userId: ownerId });

    if (isForum && input.message) {
      const messageId = generateId();
      await ctx.db.insert(messages).values({
        id: messageId,
        channelId: threadId,
        guildId,
        authorId: ownerId,
        content: input.message,
        type: 0,
      });

      await ctx.db
        .update(threads)
        .set({ messageCount: sql`${threads.messageCount} + 1` })
        .where(eq(threads.id, threadId));
    }

    logger.info({ threadId, parentId, guildId }, 'Thread created');
    return thread;
  }

  async function updateThread(threadId: string, input: UpdateThreadInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.archived !== undefined) updates.archived = input.archived;
    if (input.locked !== undefined) updates.locked = input.locked;
    if (input.autoArchiveDuration !== undefined) updates.autoArchiveDuration = input.autoArchiveDuration;
    if (input.invitable !== undefined) updates.invitable = input.invitable;
    if (input.appliedTags !== undefined) updates.appliedTags = input.appliedTags;
    if (input.pinned !== undefined) updates.pinned = input.pinned;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(threads)
      .set(updates)
      .where(eq(threads.id, threadId))
      .returning();

    return updated ?? null;
  }

  async function deleteThread(threadId: string) {
    await ctx.db.delete(threads).where(eq(threads.id, threadId));
  }

  async function joinThread(threadId: string, userId: string) {
    await ctx.db
      .insert(threadMembers)
      .values({ threadId, userId })
      .onConflictDoNothing();

    await ctx.db
      .update(threads)
      .set({ memberCount: sql`${threads.memberCount} + 1` })
      .where(eq(threads.id, threadId));
  }

  async function leaveThread(threadId: string, userId: string) {
    await ctx.db
      .delete(threadMembers)
      .where(and(eq(threadMembers.threadId, threadId), eq(threadMembers.userId, userId)));

    await ctx.db
      .update(threads)
      .set({ memberCount: sql`GREATEST(${threads.memberCount} - 1, 0)` })
      .where(eq(threads.id, threadId));
  }

  async function archiveStaleThreads() {
    await ctx.db.execute(sql`
      UPDATE ${threads} AS t
      SET archived = true
      WHERE t.archived = false
        AND COALESCE(
          (
            SELECT MAX(${messages.createdAt})
            FROM ${messages}
            WHERE ${messages.channelId} = t.id
          ),
          t.created_at
        ) < (NOW() - (t.auto_archive_duration * INTERVAL '1 minute'))
    `);
  }

  return {
    getThread,
    getThreadsForChannel,
    getThreadMembers,
    isThreadMember,
    createThread,
    updateThread,
    deleteThread,
    joinThread,
    leaveThread,
    archiveStaleThreads,
  };
}

export type ThreadsService = ReturnType<typeof createThreadsService>;
