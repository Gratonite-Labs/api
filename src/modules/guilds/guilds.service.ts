import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  guilds,
  guildMembers,
  guildRoles,
  userRoles,
  guildBrand,
  bans,
  auditLogEntries,
  guildEmojis,
  guildStickers,
  users,
  userProfiles,
  memberProfiles,
} from '@gratonite/db';
import { channels } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import { BUCKETS } from '../../lib/minio.js';
import { recordRequestCacheResult } from '../../lib/request-metrics.js';
import type { CreateGuildInput, UpdateGuildInput, CreateRoleInput, UpdateRoleInput } from './guilds.schemas.js';
import type { CreateEmojiInput, UpdateEmojiInput, CreateStickerInput, UpdateStickerInput } from './emojis.schemas.js';

// Default permissions for @everyone role
const DEFAULT_PERMISSIONS =
  (1 << 0) | // CREATE_INVITE
  (1 << 6) | // VIEW_CHANNEL
  (1 << 10) | // SEND_MESSAGES
  (1 << 11) | // SEND_MESSAGES_IN_THREADS
  (1 << 14) | // EMBED_LINKS
  (1 << 15) | // ATTACH_FILES
  (1 << 16) | // ADD_REACTIONS
  (1 << 17) | // USE_EXTERNAL_EMOJIS
  (1 << 18) | // USE_EXTERNAL_STICKERS
  (1 << 20) | // READ_MESSAGE_HISTORY
  (1 << 25) | // CONNECT
  (1 << 26) | // SPEAK
  (1 << 29) | // USE_VOICE_ACTIVITY
  (1 << 31); // CHANGE_NICKNAME

const GUILD_MEMBERS_CACHE_TTL_SECONDS = 20;
const GUILD_METADATA_CACHE_TTL_SECONDS = 20;
const USER_GUILDS_CACHE_TTL_SECONDS = 20;
const CACHE_LOG_EVERY = 100;

export function createGuildsService(ctx: AppContext) {
  type GuildMemberListItem = {
    userId: string;
    guildId: string;
    nickname: string | null;
    joinedAt: Date;
    user: {
      id: string;
      username: string;
      displayName: string;
      avatarHash: string | null;
      primaryColor: number | null;
      accentColor: number | null;
    };
    profile: {
      nickname: string | null;
      avatarHash: string | null;
      bannerHash: string | null;
      bio: string | null;
    };
  };

  type CachedGuildMemberListItem = Omit<GuildMemberListItem, 'joinedAt'> & {
    joinedAt: string;
  };

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

  function guildMembersCacheKey(guildId: string, limit: number, after?: string) {
    return `guild:${guildId}:members:${limit}:${after ?? 'start'}`;
  }

  function guildCacheKey(guildId: string) {
    return `guild:${guildId}:meta`;
  }

  function userGuildsCacheKey(userId: string) {
    return `user:${userId}:guilds`;
  }

  async function invalidateGuildCache(guildId: string) {
    try {
      await ctx.redis.del(guildCacheKey(guildId));
    } catch (error) {
      logger.warn({ error, guildId }, 'Failed to invalidate guild cache');
    }
  }

  async function invalidateUserGuildsCache(userId: string) {
    try {
      await ctx.redis.del(userGuildsCacheKey(userId));
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to invalidate user guilds cache');
    }
  }

  async function invalidateAllUserGuildsCaches() {
    let cursor = '0';

    try {
      do {
        const [nextCursor, keys] = await ctx.redis.scan(
          cursor,
          'MATCH',
          'user:*:guilds',
          'COUNT',
          100,
        );
        if (keys.length > 0) {
          await ctx.redis.del(...keys);
        }
        cursor = nextCursor;
      } while (cursor !== '0');
    } catch (error) {
      logger.warn({ error }, 'Failed to invalidate user guilds caches');
    }
  }

  async function invalidateGuildMembersCache(guildId: string) {
    const pattern = `guild:${guildId}:members:*`;
    let cursor = '0';

    try {
      do {
        const [nextCursor, keys] = await ctx.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        if (keys.length > 0) {
          await ctx.redis.del(...keys);
        }
        cursor = nextCursor;
      } while (cursor !== '0');
    } catch (error) {
      logger.warn({ error, guildId }, 'Failed to invalidate guild members cache');
    }
  }

  async function createGuild(ownerId: string, input: CreateGuildInput) {
    const guildId = generateId();
    const everyoneRoleId = generateId();
    const generalChannelId = generateId();

    // Create guild
    await ctx.db.insert(guilds).values({
      id: guildId,
      name: input.name,
      description: input.description ?? null,
      tags: input.tags ?? [],
      categories: input.categories ?? [],
      ownerId,
      memberCount: 1,
    });

    // Create @everyone role (same ID as guild, convention from Discord)
    await ctx.db.insert(guildRoles).values({
      id: everyoneRoleId,
      guildId,
      name: '@everyone',
      position: 0,
      permissions: DEFAULT_PERMISSIONS,
    });

    // Create default brand settings
    await ctx.db.insert(guildBrand).values({ guildId });

    // Create default #general text channel
    await ctx.db.insert(channels).values({
      id: generalChannelId,
      guildId,
      type: 'GUILD_TEXT',
      name: 'general',
      position: 0,
    });

    // Add owner as member
    await ctx.db.insert(guildMembers).values({ userId: ownerId, guildId });
    await invalidateUserGuildsCache(ownerId);
    await invalidateGuildCache(guildId);

    logger.info({ guildId, ownerId }, 'Guild created');

    return { guildId, everyoneRoleId, generalChannelId };
  }

  async function getGuild(guildId: string) {
    try {
      const cached = await ctx.redis.get(guildCacheKey(guildId));
      if (cached) {
        recordCacheResult('guild_meta', true);
        return JSON.parse(cached);
      }
      recordCacheResult('guild_meta', false);
    } catch (error) {
      logger.warn({ error, guildId }, 'Failed to read guild cache');
    }

    const [guild] = await ctx.db
      .select()
      .from(guilds)
      .where(eq(guilds.id, guildId))
      .limit(1);

    if (guild) {
      try {
        await ctx.redis.set(
          guildCacheKey(guildId),
          JSON.stringify(guild),
          'EX',
          GUILD_METADATA_CACHE_TTL_SECONDS,
        );
      } catch (error) {
        logger.warn({ error, guildId }, 'Failed to write guild cache');
      }
    }

    return guild ?? null;
  }

  async function updateGuild(guildId: string, input: UpdateGuildInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.iconHash !== undefined) updates.iconHash = input.iconHash;
    if (input.iconAnimated !== undefined) updates.iconAnimated = input.iconAnimated;
    if (input.bannerHash !== undefined) updates.bannerHash = input.bannerHash;
    if (input.bannerAnimated !== undefined) updates.bannerAnimated = input.bannerAnimated;
    if (input.preferredLocale !== undefined) updates.preferredLocale = input.preferredLocale;
    if (input.nsfwLevel !== undefined) updates.nsfwLevel = input.nsfwLevel;
    if (input.verificationLevel !== undefined) updates.verificationLevel = input.verificationLevel;
    if (input.explicitContentFilter !== undefined) updates.explicitContentFilter = input.explicitContentFilter;
    if (input.defaultMessageNotifications !== undefined)
      updates.defaultMessageNotifications = input.defaultMessageNotifications;
    if (input.discoverable !== undefined) updates.discoverable = input.discoverable;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.categories !== undefined) updates.categories = input.categories;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(guilds)
      .set(updates)
      .where(eq(guilds.id, guildId))
      .returning();

    await invalidateGuildCache(guildId);
    await invalidateAllUserGuildsCaches();

    return updated ?? null;
  }

  async function deleteGuild(guildId: string) {
    await ctx.db.delete(guilds).where(eq(guilds.id, guildId));
    await invalidateGuildCache(guildId);
    await invalidateGuildMembersCache(guildId);
    await invalidateAllUserGuildsCaches();
  }

  // ── Members ──────────────────────────────────────────────────────────────

  async function isMember(guildId: string, userId: string) {
    const [member] = await ctx.db
      .select({ userId: guildMembers.userId })
      .from(guildMembers)
      .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
      .limit(1);
    return !!member;
  }

  async function addMember(guildId: string, userId: string) {
    await ctx.db.insert(guildMembers).values({ userId, guildId });
    await ctx.db
      .update(guilds)
      .set({ memberCount: sql`${guilds.memberCount} + 1` })
      .where(eq(guilds.id, guildId));
    await invalidateGuildCache(guildId);
    await invalidateGuildMembersCache(guildId);
    await invalidateUserGuildsCache(userId);
  }

  async function removeMember(guildId: string, userId: string) {
    await ctx.db
      .delete(guildMembers)
      .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)));
    // Also remove their role assignments
    await ctx.db
      .delete(userRoles)
      .where(and(eq(userRoles.guildId, guildId), eq(userRoles.userId, userId)));
    await ctx.db
      .update(guilds)
      .set({ memberCount: sql`GREATEST(${guilds.memberCount} - 1, 0)` })
      .where(eq(guilds.id, guildId));
    await invalidateGuildCache(guildId);
    await invalidateGuildMembersCache(guildId);
    await invalidateUserGuildsCache(userId);
  }

  async function getMembers(guildId: string, limit = 100, after?: string) {
    const cacheKey = guildMembersCacheKey(guildId, limit, after);

    try {
      const cached = await ctx.redis.get(cacheKey);
      if (cached) {
        recordCacheResult('guild_members', true);
        const parsed = JSON.parse(cached) as CachedGuildMemberListItem[];
        return parsed.map((item) => ({
          ...item,
          joinedAt: new Date(item.joinedAt),
        }));
      }
      recordCacheResult('guild_members', false);
    } catch (error) {
      logger.warn({ error, guildId }, 'Failed to read guild members cache');
    }

    const condition = after
      ? and(eq(guildMembers.guildId, guildId), sql`${guildMembers.userId} > ${after}`)
      : eq(guildMembers.guildId, guildId);

    const rows: GuildMemberListItem[] = await ctx.db
      .select({
        userId: guildMembers.userId,
        guildId: guildMembers.guildId,
        nickname: sql<string | null>`coalesce(${memberProfiles.nickname}, ${guildMembers.nickname})`,
        joinedAt: guildMembers.joinedAt,
        user: {
          id: users.id,
          username: users.username,
          displayName: userProfiles.displayName,
          avatarHash: userProfiles.avatarHash,
          primaryColor: userProfiles.primaryColor,
          accentColor: userProfiles.accentColor,
        },
        profile: {
          nickname: memberProfiles.nickname,
          avatarHash: memberProfiles.avatarHash,
          bannerHash: memberProfiles.bannerHash,
          bio: memberProfiles.bio,
        },
      })
      .from(guildMembers)
      .innerJoin(users, eq(users.id, guildMembers.userId))
      .innerJoin(userProfiles, eq(userProfiles.userId, guildMembers.userId))
      .leftJoin(
        memberProfiles,
        and(eq(memberProfiles.userId, guildMembers.userId), eq(memberProfiles.guildId, guildMembers.guildId)),
      )
      .where(condition)
      .limit(limit);

    try {
      const payload: CachedGuildMemberListItem[] = rows.map((item) => ({
        ...item,
        joinedAt: item.joinedAt.toISOString(),
      }));
      await ctx.redis.set(
        cacheKey,
        JSON.stringify(payload),
        'EX',
        GUILD_MEMBERS_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      logger.warn({ error, guildId }, 'Failed to write guild members cache');
    }

    return rows;
  }

  async function getMember(guildId: string, userId: string) {
    const [member] = await ctx.db
      .select()
      .from(guildMembers)
      .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
      .limit(1);
    return member ?? null;
  }

  async function getUserGuilds(userId: string) {
    try {
      const cached = await ctx.redis.get(userGuildsCacheKey(userId));
      if (cached) {
        recordCacheResult('user_guilds', true);
        return JSON.parse(cached);
      }
      recordCacheResult('user_guilds', false);
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to read user guilds cache');
    }

    const memberships = await ctx.db
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(eq(guildMembers.userId, userId));

    if (memberships.length === 0) return [];

    const guildIds = memberships.map((m) => m.guildId);
    const userGuilds = await ctx.db
      .select()
      .from(guilds)
      .where(inArray(guilds.id, guildIds));

    try {
      await ctx.redis.set(
        userGuildsCacheKey(userId),
        JSON.stringify(userGuilds),
        'EX',
        USER_GUILDS_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      logger.warn({ error, userId }, 'Failed to write user guilds cache');
    }

    return userGuilds;
  }

  // ── Roles ────────────────────────────────────────────────────────────────

  async function createRole(guildId: string, input: CreateRoleInput) {
    const roleId = generateId();

    // Get the highest position for this guild
    const [highest] = await ctx.db
      .select({ position: guildRoles.position })
      .from(guildRoles)
      .where(eq(guildRoles.guildId, guildId))
      .orderBy(sql`${guildRoles.position} DESC`)
      .limit(1);

    const position = (highest?.position ?? 0) + 1;

    const [role] = await ctx.db
      .insert(guildRoles)
      .values({
        id: roleId,
        guildId,
        name: input.name,
        color: input.color ?? 0,
        hoist: input.hoist ?? false,
        mentionable: input.mentionable ?? false,
        permissions: input.permissions ?? 0,
        position,
      })
      .returning();

    return role;
  }

  async function getRoles(guildId: string) {
    return ctx.db
      .select()
      .from(guildRoles)
      .where(eq(guildRoles.guildId, guildId))
      .orderBy(guildRoles.position);
  }

  async function updateRole(roleId: string, input: UpdateRoleInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.color !== undefined) updates.color = input.color;
    if (input.hoist !== undefined) updates.hoist = input.hoist;
    if (input.mentionable !== undefined) updates.mentionable = input.mentionable;
    if (input.permissions !== undefined) updates.permissions = input.permissions;
    if (input.position !== undefined) updates.position = input.position;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(guildRoles)
      .set(updates)
      .where(eq(guildRoles.id, roleId))
      .returning();

    return updated ?? null;
  }

  async function deleteRole(roleId: string) {
    await ctx.db.delete(guildRoles).where(eq(guildRoles.id, roleId));
  }

  async function assignRole(guildId: string, userId: string, roleId: string) {
    await ctx.db
      .insert(userRoles)
      .values({ userId, roleId, guildId })
      .onConflictDoNothing();
  }

  async function removeRole(guildId: string, userId: string, roleId: string) {
    await ctx.db
      .delete(userRoles)
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(userRoles.roleId, roleId),
          eq(userRoles.guildId, guildId),
        ),
      );
  }

  async function getMemberRoles(guildId: string, userId: string) {
    const assignments = await ctx.db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(and(eq(userRoles.guildId, guildId), eq(userRoles.userId, userId)));

    if (assignments.length === 0) return [];

    const roleIds = assignments.map((a) => a.roleId);
    return ctx.db
      .select()
      .from(guildRoles)
      .where(inArray(guildRoles.id, roleIds));
  }

  async function getMemberPermissions(guildId: string, userId: string): Promise<bigint> {
    // Owner has all permissions
    const guild = await getGuild(guildId);
    if (!guild) return 0n;
    if (guild.ownerId === userId) return ~0n; // all bits set

    // Get @everyone role permissions (base)
    const [everyoneRole] = await ctx.db
      .select()
      .from(guildRoles)
      .where(and(eq(guildRoles.guildId, guildId), eq(guildRoles.name, '@everyone')))
      .limit(1);

    let perms = everyoneRole ? BigInt(everyoneRole.permissions) : 0n;

    // Combine with all assigned role permissions
    const memberRoles = await getMemberRoles(guildId, userId);
    for (const role of memberRoles) {
      perms |= BigInt(role.permissions);
    }
    return perms;
  }

  // ── Bans ─────────────────────────────────────────────────────────────────

  async function banMember(guildId: string, userId: string, moderatorId: string, reason?: string) {
    await ctx.db.insert(bans).values({
      guildId,
      userId,
      moderatorId,
      reason: reason ?? null,
    });
    // Remove from members
    await removeMember(guildId, userId);
  }

  async function unbanMember(guildId: string, userId: string) {
    await ctx.db
      .delete(bans)
      .where(and(eq(bans.guildId, guildId), eq(bans.userId, userId)));
  }

  async function isBanned(guildId: string, userId: string) {
    const [ban] = await ctx.db
      .select({ guildId: bans.guildId })
      .from(bans)
      .where(and(eq(bans.guildId, guildId), eq(bans.userId, userId)))
      .limit(1);
    return !!ban;
  }

  async function getBans(guildId: string) {
    return ctx.db
      .select()
      .from(bans)
      .where(eq(bans.guildId, guildId));
  }

  // ── Audit log ────────────────────────────────────────────────────────────

  async function createAuditLogEntry(data: {
    guildId: string;
    userId: string;
    targetId?: string;
    actionType: number;
    changes?: unknown;
    reason?: string;
  }) {
    await ctx.db.insert(auditLogEntries).values({
      id: generateId(),
      guildId: data.guildId,
      userId: data.userId,
      targetId: data.targetId ?? null,
      actionType: data.actionType,
      changes: data.changes ?? null,
      reason: data.reason ?? null,
    });
  }

  // ── Emojis ───────────────────────────────────────────────────────────────

  async function createEmoji(
    guildId: string,
    creatorId: string,
    input: CreateEmojiInput,
    hash: string,
    animated: boolean,
  ) {
    const emojiId = generateId();

    const [emoji] = await ctx.db
      .insert(guildEmojis)
      .values({
        id: emojiId,
        guildId,
        name: input.name,
        hash,
        animated,
        creatorId,
      })
      .returning();

    logger.info({ emojiId, guildId, name: input.name }, 'Emoji created');
    return {
      ...emoji,
      url: `${ctx.env.CDN_BASE_URL}/${BUCKETS.emojis.name}/${guildId}/${hash}`,
    };
  }

  async function getGuildEmojis(guildId: string) {
    const emojis = await ctx.db
      .select()
      .from(guildEmojis)
      .where(eq(guildEmojis.guildId, guildId));

    return emojis.map((e) => ({
      ...e,
      url: `${ctx.env.CDN_BASE_URL}/${BUCKETS.emojis.name}/${guildId}/${e.hash}`,
    }));
  }

  async function getEmoji(emojiId: string) {
    const [emoji] = await ctx.db
      .select()
      .from(guildEmojis)
      .where(eq(guildEmojis.id, emojiId))
      .limit(1);
    if (!emoji) return null;
    return {
      ...emoji,
      url: `${ctx.env.CDN_BASE_URL}/${BUCKETS.emojis.name}/${emoji.guildId}/${emoji.hash}`,
    };
  }

  async function updateEmoji(emojiId: string, input: UpdateEmojiInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(guildEmojis)
      .set(updates)
      .where(eq(guildEmojis.id, emojiId))
      .returning();

    if (!updated) return null;
    return {
      ...updated,
      url: `${ctx.env.CDN_BASE_URL}/${BUCKETS.emojis.name}/${updated.guildId}/${updated.hash}`,
    };
  }

  async function deleteEmoji(emojiId: string) {
    const [emoji] = await ctx.db
      .delete(guildEmojis)
      .where(eq(guildEmojis.id, emojiId))
      .returning();
    if (emoji) {
      // Delete from MinIO
      try {
        await ctx.minio.removeObject(BUCKETS.emojis.name, `${emoji.guildId}/${emoji.hash}`);
      } catch (err) {
        logger.warn({ err, emojiId }, 'Failed to delete emoji from storage');
      }
    }
    return emoji ?? null;
  }

  // ── Stickers ────────────────────────────────────────────────────────────

  async function createSticker(
    guildId: string,
    creatorId: string,
    input: CreateStickerInput,
    hash: string,
    formatType: string,
  ) {
    const stickerId = generateId();

    const [sticker] = await ctx.db
      .insert(guildStickers)
      .values({
        id: stickerId,
        guildId,
        name: input.name,
        description: input.description ?? null,
        hash,
        formatType,
        tags: input.tags ?? null,
        creatorId,
      })
      .returning();

    logger.info({ stickerId, guildId, name: input.name }, 'Sticker created');
    return {
      ...sticker,
      url: `${ctx.env.CDN_BASE_URL}/${BUCKETS.stickers.name}/${guildId}/${hash}`,
    };
  }

  async function getGuildStickers(guildId: string) {
    const stickers = await ctx.db
      .select()
      .from(guildStickers)
      .where(eq(guildStickers.guildId, guildId));

    return stickers.map((s) => ({
      ...s,
      url: `${ctx.env.CDN_BASE_URL}/${BUCKETS.stickers.name}/${guildId}/${s.hash}`,
    }));
  }

  async function getSticker(stickerId: string) {
    const [sticker] = await ctx.db
      .select()
      .from(guildStickers)
      .where(eq(guildStickers.id, stickerId))
      .limit(1);
    if (!sticker) return null;
    return {
      ...sticker,
      url: `${ctx.env.CDN_BASE_URL}/${BUCKETS.stickers.name}/${sticker.guildId}/${sticker.hash}`,
    };
  }

  async function updateSticker(stickerId: string, input: UpdateStickerInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.tags !== undefined) updates.tags = input.tags;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(guildStickers)
      .set(updates)
      .where(eq(guildStickers.id, stickerId))
      .returning();

    if (!updated) return null;
    return {
      ...updated,
      url: `${ctx.env.CDN_BASE_URL}/${BUCKETS.stickers.name}/${updated.guildId}/${updated.hash}`,
    };
  }

  async function deleteSticker(stickerId: string) {
    const [sticker] = await ctx.db
      .delete(guildStickers)
      .where(eq(guildStickers.id, stickerId))
      .returning();
    if (sticker) {
      // Delete from MinIO
      try {
        await ctx.minio.removeObject(BUCKETS.stickers.name, `${sticker.guildId}/${sticker.hash}`);
      } catch (err) {
        logger.warn({ err, stickerId }, 'Failed to delete sticker from storage');
      }
    }
    return sticker ?? null;
  }

  return {
    createGuild,
    getGuild,
    updateGuild,
    deleteGuild,
    isMember,
    addMember,
    removeMember,
    getMembers,
    getMember,
    getUserGuilds,
    createRole,
    getRoles,
    updateRole,
    deleteRole,
    assignRole,
    removeRole,
    getMemberRoles,
    getMemberPermissions,
    banMember,
    unbanMember,
    isBanned,
    getBans,
    createAuditLogEntry,
    invalidateGuildCache,
    // Emojis
    createEmoji,
    getGuildEmojis,
    getEmoji,
    updateEmoji,
    deleteEmoji,
    // Stickers
    createSticker,
    getGuildStickers,
    getSticker,
    updateSticker,
    deleteSticker,
    // Discord import
    parseDiscordExport,
    createGuildFromImport,
  };

  // ── Discord Import ─────────────────────────────────────────────────────

  interface DiscordImportChannel {
    name: string;
    type: 'text' | 'voice';
    topic?: string;
  }

  interface DiscordImportCategory {
    name: string;
    channels: DiscordImportChannel[];
  }

  interface DiscordImportRole {
    name: string;
    color: string;
  }

  interface DiscordImportResult {
    name: string;
    categories: DiscordImportCategory[];
    roles: DiscordImportRole[];
  }

  function parseDiscordExport(data: unknown): DiscordImportResult {
    const raw = data as any;

    // Support both "guild" wrapper and flat structure
    const guild = raw?.guild ?? raw;
    if (!guild || typeof guild !== 'object') {
      throw new Error('INVALID_FORMAT');
    }

    const name = String(guild.name ?? 'Imported Server').slice(0, 100);

    // Parse channels: type 0=text, 2=voice, 4=category
    const rawChannels: any[] = Array.isArray(guild.channels) ? guild.channels : [];

    // Build category map
    const categoryMap = new Map<string | null, { name: string; channels: DiscordImportChannel[] }>();
    const categoryOrder: (string | null)[] = [];

    for (const ch of rawChannels) {
      if (ch.type === 4) {
        categoryMap.set(ch.id, { name: String(ch.name ?? 'Category').slice(0, 100), channels: [] });
        categoryOrder.push(ch.id);
      }
    }

    // Place channels under their parent category
    for (const ch of rawChannels) {
      if (ch.type === 4) continue;
      const type: 'text' | 'voice' = ch.type === 2 ? 'voice' : 'text';
      const parentId = ch.parent_id ?? null;
      const channel: DiscordImportChannel = {
        name: String(ch.name ?? 'channel').slice(0, 100),
        type,
        topic: ch.topic ? String(ch.topic).slice(0, 1024) : undefined,
      };

      if (parentId && categoryMap.has(parentId)) {
        categoryMap.get(parentId)!.channels.push(channel);
      } else {
        // Channels without a category go to a "General" fallback
        if (!categoryMap.has(null)) {
          categoryMap.set(null, { name: 'General', channels: [] });
          categoryOrder.push(null);
        }
        categoryMap.get(null)!.channels.push(channel);
      }
    }

    const categories = categoryOrder
      .map((id) => categoryMap.get(id)!)
      .filter((cat) => cat.channels.length > 0)
      .slice(0, 20);

    // Limit total channels to 50
    let totalChannels = 0;
    for (const cat of categories) {
      const remaining = 50 - totalChannels;
      if (remaining <= 0) { cat.channels = []; continue; }
      cat.channels = cat.channels.slice(0, remaining);
      totalChannels += cat.channels.length;
    }

    // Parse roles (skip @everyone and managed bot roles)
    const rawRoles: any[] = Array.isArray(guild.roles) ? guild.roles : [];
    const roles: DiscordImportRole[] = rawRoles
      .filter((r) => r.name !== '@everyone' && !r.managed)
      .map((r) => ({
        name: String(r.name).slice(0, 100),
        color: r.color ? `#${Number(r.color).toString(16).padStart(6, '0')}` : '#99aab5',
      }))
      .slice(0, 25);

    return { name, categories, roles };
  }

  async function createGuildFromImport(
    ownerId: string,
    input: DiscordImportResult,
  ) {
    // Create the guild
    const { guildId } = await createGuild(ownerId, { name: input.name });

    // Create categories and channels
    let position = 1; // 0 is taken by the default general channel
    for (const category of input.categories) {
      const catId = generateId();
      await ctx.db.insert(channels).values({
        id: catId,
        guildId,
        type: 'GUILD_CATEGORY',
        name: category.name,
        position: position++,
      });

      for (const ch of category.channels) {
        const chId = generateId();
        await ctx.db.insert(channels).values({
          id: chId,
          guildId,
          type: ch.type === 'voice' ? 'GUILD_VOICE' : 'GUILD_TEXT',
          name: ch.name,
          topic: ch.topic ?? null,
          parentId: catId,
          position: position++,
        });
      }
    }

    // Create roles
    let rolePosition = 1;
    for (const role of input.roles) {
      const roleId = generateId();
      await ctx.db.insert(guildRoles).values({
        id: roleId,
        guildId,
        name: role.name,
        color: role.color,
        position: rolePosition++,
        permissions: DEFAULT_PERMISSIONS,
      });
    }

    return { guildId };
  }
}

export type GuildsService = ReturnType<typeof createGuildsService>;
