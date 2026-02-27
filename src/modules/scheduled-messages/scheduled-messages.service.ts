import { eq, and, lte, sql } from 'drizzle-orm';
import { scheduledMessages } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import type { CreateScheduledMessageInput, ListScheduledMessagesInput } from './scheduled-messages.schemas.js';

export function createScheduledMessagesService(ctx: AppContext) {
  async function create(guildId: string, authorId: string, input: CreateScheduledMessageInput) {
    const id = generateId();

    const [msg] = await ctx.db
      .insert(scheduledMessages)
      .values({
        id,
        guildId,
        channelId: input.channelId,
        authorId,
        content: input.content,
        embeds: input.embeds,
        scheduledFor: new Date(input.scheduledFor),
        status: 'pending',
      })
      .returning();

    ctx.io.to(`guild:${guildId}`).emit('SCHEDULED_MESSAGE_CREATE', msg);

    return msg;
  }

  async function list(guildId: string, options: ListScheduledMessagesInput) {
    const conditions = [eq(scheduledMessages.guildId, guildId)];

    if (options.channelId) {
      conditions.push(eq(scheduledMessages.channelId, options.channelId));
    }

    if (options.status) {
      conditions.push(eq(scheduledMessages.status, options.status as any));
    }

    return ctx.db
      .select()
      .from(scheduledMessages)
      .where(and(...conditions))
      .orderBy(scheduledMessages.scheduledFor)
      .limit(options.limit);
  }

  async function getById(id: string) {
    const [msg] = await ctx.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, id));
    return msg ?? null;
  }

  async function cancel(id: string, requesterId: string) {
    const msg = await getById(id);
    if (!msg) return { error: 'NOT_FOUND' as const };
    if (msg.authorId !== requesterId) return { error: 'FORBIDDEN' as const };
    if (msg.status !== 'pending') return { error: 'NOT_PENDING' as const };

    const [updated] = await ctx.db
      .update(scheduledMessages)
      .set({ status: 'cancelled' })
      .where(eq(scheduledMessages.id, id))
      .returning();

    ctx.io.to(`guild:${msg.guildId}`).emit('SCHEDULED_MESSAGE_DELETE', { id });

    return { success: true, msg: updated };
  }

  /**
   * Called by a cron/worker to dispatch any pending messages whose scheduledFor <= now.
   * Returns count dispatched.
   */
  async function dispatchDue() {
    const now = new Date();

    const due = await ctx.db
      .update(scheduledMessages)
      .set({ status: 'sent', sentAt: now })
      .where(and(eq(scheduledMessages.status, 'pending'), lte(scheduledMessages.scheduledFor, now)))
      .returning();

    for (const msg of due) {
      try {
        // Emit a regular message-like event so the gateway picks it up
        ctx.io.to(`channel:${msg.channelId}`).emit('SCHEDULED_MESSAGE_DISPATCH', {
          channelId: msg.channelId,
          guildId: msg.guildId,
          content: msg.content,
          embeds: msg.embeds,
          authorId: msg.authorId,
          scheduledMessageId: msg.id,
        });
        logger.info({ id: msg.id, channelId: msg.channelId }, 'Dispatched scheduled message');
      } catch (err) {
        logger.error({ err, id: msg.id }, 'Failed to dispatch scheduled message');
        await ctx.db
          .update(scheduledMessages)
          .set({ status: 'failed' })
          .where(eq(scheduledMessages.id, msg.id));
      }
    }

    return due.length;
  }

  return { create, list, getById, cancel, dispatchDue };
}

export type ScheduledMessagesService = ReturnType<typeof createScheduledMessagesService>;
