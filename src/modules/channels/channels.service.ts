import { eq, and, sql, inArray } from 'drizzle-orm';
import { channels, channelPermissions, guilds, guildRoles, userRoles } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import type { CreateChannelInput, UpdateChannelInput } from './channels.schemas.js';
import { logger } from '../../lib/logger.js';
import { recordRequestCacheResult } from '../../lib/request-metrics.js';
import { hasPermission, PermissionFlags } from '@gratonite/types';

const CHANNEL_CACHE_TTL_SECONDS = 20;
const CACHE_LOG_EVERY = 100;

export function createChannelsService(ctx: AppContext) {
  const cacheStats: Record<string, { hits: number; misses: number }> = {};

  function recordCacheResult(cache: string, hit: boolean) {
    recordRequestCacheResult(cache, hit);

    if (!cacheStats[cache]) {
      cacheStats[cache] = { hits: 0, misses: 0 };
    }

    if (hit) {
      cacheStats[cache].hits += 1;
    } else {
      cacheStats[cache].misses += 1;
    }

    const total = cacheStats[cache].hits + cacheStats[cache].misses;
    if (total % CACHE_LOG_EVERY === 0) {
      logger.info(
        {
          cache,
          hits: cacheStats[cache].hits,
          misses: cacheStats[cache].misses,
          hitRate: cacheStats[cache].hits / total,
        },
        'Cache stats',
      );
    }
  }

  function channelCacheKey(channelId: string) {
    return `channel:${channelId}:meta`;
  }

  function guildChannelsCacheKey(guildId: string) {
    return `guild:${guildId}:channels`;
  }

  async function invalidateChannelCache(channelId: string) {
    try {
      await ctx.redis.del(channelCacheKey(channelId));
    } catch (error) {
      logger.warn({ error, channelId }, 'Failed to invalidate channel cache');
    }
  }

  async function invalidateGuildChannelsCache(guildId: string) {
    try {
      await ctx.redis.del(guildChannelsCacheKey(guildId));
    } catch (error) {
      logger.warn({ error, guildId }, 'Failed to invalidate guild channels cache');
    }
  }

  async function createChannel(guildId: string, input: CreateChannelInput) {
    const channelId = generateId();

    const [channel] = await ctx.db
      .insert(channels)
      .values({
        id: channelId,
        guildId,
        type: input.type,
        name: input.name,
        topic: input.topic ?? null,
        parentId: input.parentId ?? null,
        nsfw: input.nsfw ?? false,
        rateLimitPerUser: input.rateLimitPerUser ?? 0,
        position: input.position ?? 0,
      })
      .returning();

    await invalidateGuildChannelsCache(guildId);
    return channel;
  }

  async function getChannel(channelId: string) {
    try {
      const cached = await ctx.redis.get(channelCacheKey(channelId));
      if (cached) {
        recordCacheResult('channel_meta', true);
        return JSON.parse(cached);
      }
      recordCacheResult('channel_meta', false);
    } catch (error) {
      logger.warn({ error, channelId }, 'Failed to read channel cache');
    }

    const [channel] = await ctx.db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    if (channel) {
      try {
        await ctx.redis.set(
          channelCacheKey(channelId),
          JSON.stringify(channel),
          'EX',
          CHANNEL_CACHE_TTL_SECONDS,
        );
      } catch (error) {
        logger.warn({ error, channelId }, 'Failed to write channel cache');
      }
    }

    return channel ?? null;
  }

  async function getGuildChannels(guildId: string) {
    try {
      const cached = await ctx.redis.get(guildChannelsCacheKey(guildId));
      if (cached) {
        recordCacheResult('guild_channels', true);
        return JSON.parse(cached);
      }
      recordCacheResult('guild_channels', false);
    } catch (error) {
      logger.warn({ error, guildId }, 'Failed to read guild channels cache');
    }

    const guildChannels = await ctx.db
      .select()
      .from(channels)
      .where(eq(channels.guildId, guildId))
      .orderBy(channels.position);

    try {
      await ctx.redis.set(
        guildChannelsCacheKey(guildId),
        JSON.stringify(guildChannels),
        'EX',
        CHANNEL_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      logger.warn({ error, guildId }, 'Failed to write guild channels cache');
    }

    return guildChannels;
  }

  async function updateChannel(channelId: string, input: UpdateChannelInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.topic !== undefined) updates.topic = input.topic;
    if (input.nsfw !== undefined) updates.nsfw = input.nsfw;
    if (input.rateLimitPerUser !== undefined) updates.rateLimitPerUser = input.rateLimitPerUser;
    if (input.parentId !== undefined) updates.parentId = input.parentId ?? null;
    if (input.position !== undefined) updates.position = input.position;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(channels)
      .set(updates)
      .where(eq(channels.id, channelId))
      .returning();

    if (updated) {
      await invalidateChannelCache(channelId);
      if (updated.guildId) {
        await invalidateGuildChannelsCache(String(updated.guildId));
      }
    }

    return updated ?? null;
  }

  async function deleteChannel(channelId: string) {
    const [existing] = await ctx.db
      .select({ guildId: channels.guildId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    await ctx.db.delete(channels).where(eq(channels.id, channelId));
    await invalidateChannelCache(channelId);
    if (existing?.guildId) {
      await invalidateGuildChannelsCache(String(existing.guildId));
    }
  }

  async function reorderChannels(
    guildId: string,
    positions: Array<{ id: string; position: number; parentId?: string | null }>,
  ) {
    for (const item of positions) {
      const updates: Record<string, unknown> = { position: item.position };
      if (item.parentId !== undefined) {
        updates.parentId = item.parentId ?? null;
      }
      await ctx.db
        .update(channels)
        .set(updates)
        .where(and(eq(channels.id, item.id), eq(channels.guildId, guildId)));
      await invalidateChannelCache(item.id);
    }
    await invalidateGuildChannelsCache(guildId);
  }

  // ── Permission overrides ─────────────────────────────────────────────────

  async function getPermissionOverrides(channelId: string) {
    return ctx.db
      .select()
      .from(channelPermissions)
      .where(eq(channelPermissions.channelId, channelId));
  }

  async function setPermissionOverride(
    channelId: string,
    targetId: string,
    targetType: 'role' | 'user',
    allow: string,
    deny: string,
  ) {
    // Upsert: try update first, then insert
    const existing = await ctx.db
      .select()
      .from(channelPermissions)
      .where(
        and(
          eq(channelPermissions.channelId, channelId),
          eq(channelPermissions.targetId, targetId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const [updated] = await ctx.db
        .update(channelPermissions)
        .set({ allow, deny })
        .where(
          and(
            eq(channelPermissions.channelId, channelId),
            eq(channelPermissions.targetId, targetId),
          ),
        )
        .returning();
      return updated;
    }

    const [created] = await ctx.db
      .insert(channelPermissions)
      .values({
        id: generateId(),
        channelId,
        targetId,
        targetType,
        allow,
        deny,
      })
      .returning();

    return created;
  }

  async function deletePermissionOverride(channelId: string, targetId: string) {
    await ctx.db
      .delete(channelPermissions)
      .where(
        and(
          eq(channelPermissions.channelId, channelId),
          eq(channelPermissions.targetId, targetId),
        ),
      );
  }

  async function getMemberChannelPermissions(channelId: string, userId: string): Promise<bigint | null> {
    const channel = await getChannel(channelId);
    if (!channel) return null;

    // Non-guild channels are managed by dedicated membership checks in route handlers.
    if (!channel.guildId) return ~0n;

    const guildId = String(channel.guildId);
    const [guild] = await ctx.db
      .select({ ownerId: guilds.ownerId })
      .from(guilds)
      .where(eq(guilds.id, guildId))
      .limit(1);

    if (!guild) return 0n;
    if (guild.ownerId === userId) return ~0n;

    const [everyoneRole] = await ctx.db
      .select({ id: guildRoles.id, permissions: guildRoles.permissions })
      .from(guildRoles)
      .where(and(eq(guildRoles.guildId, guildId), eq(guildRoles.name, '@everyone')))
      .limit(1);

    let permissions = everyoneRole ? BigInt(everyoneRole.permissions) : 0n;

    const assignedRoles = await ctx.db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(and(eq(userRoles.guildId, guildId), eq(userRoles.userId, userId)));

    const memberRoleIds = assignedRoles.map((row) => row.roleId);
    if (memberRoleIds.length > 0) {
      const roles = await ctx.db
        .select({ id: guildRoles.id, permissions: guildRoles.permissions })
        .from(guildRoles)
        .where(inArray(guildRoles.id, memberRoleIds));

      for (const role of roles) {
        permissions |= BigInt(role.permissions);
      }
    }

    if (hasPermission(permissions, PermissionFlags.ADMINISTRATOR)) {
      return ~0n;
    }

    const overrides = await getPermissionOverrides(channelId);

    const everyoneOverride = everyoneRole
      ? overrides.find(
          (override) =>
            override.targetType === 'role' && override.targetId === everyoneRole.id,
        )
      : undefined;

    if (everyoneOverride) {
      permissions &= ~BigInt(everyoneOverride.deny);
      permissions |= BigInt(everyoneOverride.allow);
    }

    let roleAllow = 0n;
    let roleDeny = 0n;
    for (const override of overrides) {
      if (override.targetType !== 'role') continue;
      if (everyoneRole && override.targetId === everyoneRole.id) continue;
      if (!memberRoleIds.includes(override.targetId)) continue;
      roleAllow |= BigInt(override.allow);
      roleDeny |= BigInt(override.deny);
    }
    permissions &= ~roleDeny;
    permissions |= roleAllow;

    const userOverride = overrides.find(
      (override) =>
        override.targetType === 'user' && override.targetId === userId,
    );
    if (userOverride) {
      permissions &= ~BigInt(userOverride.deny);
      permissions |= BigInt(userOverride.allow);
    }

    return permissions;
  }

  async function canAccessChannel(channelId: string, userId: string) {
    const permissions = await getMemberChannelPermissions(channelId, userId);
    if (permissions === null) return false;
    return hasPermission(permissions, PermissionFlags.VIEW_CHANNEL);
  }

  async function canConnectToVoiceChannel(channelId: string, userId: string) {
    const permissions = await getMemberChannelPermissions(channelId, userId);
    if (permissions === null) return false;
    return (
      hasPermission(permissions, PermissionFlags.VIEW_CHANNEL) &&
      hasPermission(permissions, PermissionFlags.CONNECT)
    );
  }

  return {
    createChannel,
    getChannel,
    getGuildChannels,
    updateChannel,
    deleteChannel,
    reorderChannels,
    getPermissionOverrides,
    setPermissionOverride,
    deletePermissionOverride,
    getMemberChannelPermissions,
    canAccessChannel,
    canConnectToVoiceChannel,
  };
}

export type ChannelsService = ReturnType<typeof createChannelsService>;
