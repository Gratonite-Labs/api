import { eq, and, desc, lt, lte, sql } from 'drizzle-orm';
import { guildScheduledEvents, guildScheduledEventUsers } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import type { CreateEventInput, UpdateEventInput } from './events.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

export function createEventsService(ctx: AppContext) {
  async function createEvent(guildId: string, creatorId: string, input: CreateEventInput) {
    const id = generateId();

    const [event] = await ctx.db
      .insert(guildScheduledEvents)
      .values({
        id,
        guildId,
        channelId: input.channelId ?? null,
        creatorId,
        name: input.name,
        description: input.description ?? null,
        scheduledStartTime: new Date(input.scheduledStartTime),
        scheduledEndTime: input.scheduledEndTime ? new Date(input.scheduledEndTime) : null,
        entityType: input.entityType,
        entityMetadata: input.entityMetadata ?? null,
      })
      .returning();

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_SCHEDULED_EVENT_CREATE',
      event as any,
    );

    return event;
  }

  async function getEvent(eventId: string) {
    const [event] = await ctx.db
      .select()
      .from(guildScheduledEvents)
      .where(eq(guildScheduledEvents.id, eventId));
    return event ?? null;
  }

  async function getGuildEvents(
    guildId: string,
    options: { status?: string; limit: number; before?: string },
  ) {
    const conditions = [eq(guildScheduledEvents.guildId, guildId)];

    if (options.status) {
      conditions.push(eq(guildScheduledEvents.status, options.status as any));
    }
    if (options.before) {
      conditions.push(lt(guildScheduledEvents.id, options.before));
    }

    return ctx.db
      .select()
      .from(guildScheduledEvents)
      .where(and(...conditions))
      .orderBy(guildScheduledEvents.scheduledStartTime)
      .limit(options.limit);
  }

  async function updateEvent(eventId: string, input: UpdateEventInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.scheduledStartTime !== undefined) {
      updates.scheduledStartTime = new Date(input.scheduledStartTime);
    }
    if (input.scheduledEndTime !== undefined) {
      updates.scheduledEndTime = input.scheduledEndTime
        ? new Date(input.scheduledEndTime)
        : null;
    }
    if (input.status !== undefined) updates.status = input.status;
    if (input.entityMetadata !== undefined) updates.entityMetadata = input.entityMetadata;

    const [updated] = await ctx.db
      .update(guildScheduledEvents)
      .set(updates)
      .where(eq(guildScheduledEvents.id, eventId))
      .returning();

    if (updated) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${updated.guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_SCHEDULED_EVENT_UPDATE',
        updated as any,
      );
    }

    return updated ?? null;
  }

  async function deleteEvent(eventId: string) {
    const event = await getEvent(eventId);
    if (!event) return { error: 'NOT_FOUND' as const };

    await ctx.db.delete(guildScheduledEvents).where(eq(guildScheduledEvents.id, eventId));

    await emitRoomWithIntent(
      ctx.io,
      `guild:${event.guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_SCHEDULED_EVENT_DELETE',
      {
        id: eventId,
        guildId: event.guildId,
      },
    );

    return { success: true };
  }

  async function addInterestedUser(eventId: string, userId: string, guildId: string) {
    // Check if already interested
    const [existing] = await ctx.db
      .select()
      .from(guildScheduledEventUsers)
      .where(
        and(
          eq(guildScheduledEventUsers.eventId, eventId),
          eq(guildScheduledEventUsers.userId, userId),
        ),
      );

    if (existing) return { already: true };

    await ctx.db.insert(guildScheduledEventUsers).values({ eventId, userId });

    await ctx.db
      .update(guildScheduledEvents)
      .set({ interestedCount: sql`${guildScheduledEvents.interestedCount} + 1` })
      .where(eq(guildScheduledEvents.id, eventId));

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_SCHEDULED_EVENT_USER_ADD',
      {
        eventId,
        userId,
        guildId,
      },
    );

    return { success: true };
  }

  async function removeInterestedUser(eventId: string, userId: string, guildId: string) {
    const [existing] = await ctx.db
      .select()
      .from(guildScheduledEventUsers)
      .where(
        and(
          eq(guildScheduledEventUsers.eventId, eventId),
          eq(guildScheduledEventUsers.userId, userId),
        ),
      );

    if (!existing) return { error: 'NOT_FOUND' as const };

    await ctx.db
      .delete(guildScheduledEventUsers)
      .where(
        and(
          eq(guildScheduledEventUsers.eventId, eventId),
          eq(guildScheduledEventUsers.userId, userId),
        ),
      );

    await ctx.db
      .update(guildScheduledEvents)
      .set({
        interestedCount: sql`greatest(${guildScheduledEvents.interestedCount} - 1, 0)`,
      })
      .where(eq(guildScheduledEvents.id, eventId));

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_SCHEDULED_EVENT_USER_REMOVE',
      {
        eventId,
        userId,
        guildId,
      },
    );

    return { success: true };
  }

  async function getEventUsers(eventId: string, limit = 100) {
    return ctx.db
      .select()
      .from(guildScheduledEventUsers)
      .where(eq(guildScheduledEventUsers.eventId, eventId))
      .orderBy(guildScheduledEventUsers.interestedAt)
      .limit(limit);
  }

  async function autoStartEvents() {
    const now = new Date();
    const events = await ctx.db
      .update(guildScheduledEvents)
      .set({ status: 'active' })
      .where(
        and(
          eq(guildScheduledEvents.status, 'scheduled'),
          lte(guildScheduledEvents.scheduledStartTime, now),
        ),
      )
      .returning();

    for (const event of events) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${event.guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_SCHEDULED_EVENT_UPDATE',
        event as any,
      );
      logger.info({ eventId: event.id, guildId: event.guildId }, 'Auto-started scheduled event');
    }

    return events.length;
  }

  return {
    createEvent,
    getEvent,
    getGuildEvents,
    updateEvent,
    deleteEvent,
    addInterestedUser,
    removeInterestedUser,
    getEventUsers,
    autoStartEvents,
  };
}

export type EventsService = ReturnType<typeof createEventsService>;
