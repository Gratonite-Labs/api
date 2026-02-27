import { and, eq, asc, sql } from 'drizzle-orm';
import {
  memberProfiles,
  avatarDecorations,
  profileEffects,
  nameplates,
  userProfiles,
} from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import type { UpdateMemberProfileInput, EquipCustomizationInput } from './profiles.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

export function createProfilesService(ctx: AppContext) {
  // ── Member profiles (per-server) ───────────────────────────────────────

  async function getMemberProfile(userId: string, guildId: string) {
    const rows = await ctx.db
      .select()
      .from(memberProfiles)
      .where(and(eq(memberProfiles.userId, userId), eq(memberProfiles.guildId, guildId)))
      .limit(1);

    return rows[0] || null;
  }

  async function updateMemberProfile(
    userId: string,
    guildId: string,
    input: UpdateMemberProfileInput,
  ) {
    const existing = await getMemberProfile(userId, guildId);

    if (existing) {
      const updates: Record<string, unknown> = {};
      if (input.nickname !== undefined) updates.nickname = input.nickname;
      if (input.bio !== undefined) updates.bio = input.bio;

      const [updated] = await ctx.db
        .update(memberProfiles)
        .set(updates)
        .where(
          and(eq(memberProfiles.userId, userId), eq(memberProfiles.guildId, guildId)),
        )
        .returning();

      if (updated) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${guildId}`,
          GatewayIntents.GUILD_MEMBERS,
          'MEMBER_PROFILE_UPDATE',
          {
            guildId,
            userId,
            profile: updated,
          },
        );
      }

      return updated;
    } else {
      const [created] = await ctx.db
        .insert(memberProfiles)
        .values({
          userId,
          guildId,
          nickname: input.nickname ?? null,
          bio: input.bio ?? null,
        })
        .returning();

      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILD_MEMBERS,
        'MEMBER_PROFILE_UPDATE',
        {
          guildId,
          userId,
          profile: created,
        },
      );

      return created;
    }
  }

  async function updateMemberAvatar(
    userId: string,
    guildId: string,
    hash: string | null,
    animated: boolean,
  ) {
    // Upsert
    const existing = await getMemberProfile(userId, guildId);

    if (existing) {
      const [updated] = await ctx.db
        .update(memberProfiles)
        .set({ avatarHash: hash, avatarAnimated: animated })
        .where(
          and(eq(memberProfiles.userId, userId), eq(memberProfiles.guildId, guildId)),
        )
        .returning();

      if (updated) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${guildId}`,
          GatewayIntents.GUILD_MEMBERS,
          'MEMBER_PROFILE_UPDATE',
          {
            guildId,
            userId,
            profile: updated,
          },
        );
      }

      return updated;
    } else {
      const [created] = await ctx.db
        .insert(memberProfiles)
        .values({ userId, guildId, avatarHash: hash, avatarAnimated: animated })
        .returning();

      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILD_MEMBERS,
        'MEMBER_PROFILE_UPDATE',
        {
          guildId,
          userId,
          profile: created,
        },
      );

      return created;
    }
  }

  async function updateMemberBanner(
    userId: string,
    guildId: string,
    hash: string | null,
    animated: boolean,
  ) {
    const existing = await getMemberProfile(userId, guildId);

    if (existing) {
      const [updated] = await ctx.db
        .update(memberProfiles)
        .set({ bannerHash: hash, bannerAnimated: animated })
        .where(
          and(eq(memberProfiles.userId, userId), eq(memberProfiles.guildId, guildId)),
        )
        .returning();

      if (updated) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${guildId}`,
          GatewayIntents.GUILD_MEMBERS,
          'MEMBER_PROFILE_UPDATE',
          {
            guildId,
            userId,
            profile: updated,
          },
        );
      }

      return updated;
    } else {
      const [created] = await ctx.db
        .insert(memberProfiles)
        .values({ userId, guildId, bannerHash: hash, bannerAnimated: animated })
        .returning();

      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILD_MEMBERS,
        'MEMBER_PROFILE_UPDATE',
        {
          guildId,
          userId,
          profile: created,
        },
      );

      return created;
    }
  }

  // ── Avatar decorations catalog ─────────────────────────────────────────

  async function getAvatarDecorations() {
    return ctx.db
      .select()
      .from(avatarDecorations)
      .where(eq(avatarDecorations.available, true))
      .orderBy(asc(avatarDecorations.sortOrder), asc(avatarDecorations.name));
  }

  // ── Profile effects catalog ────────────────────────────────────────────

  async function getProfileEffects() {
    return ctx.db
      .select()
      .from(profileEffects)
      .where(eq(profileEffects.available, true))
      .orderBy(asc(profileEffects.sortOrder), asc(profileEffects.name));
  }

  // ── Nameplates catalog ────────────────────────────────────────────────

  async function getNameplates() {
    return ctx.db
      .select()
      .from(nameplates)
      .where(eq(nameplates.available, true))
      .orderBy(asc(nameplates.sortOrder), asc(nameplates.name));
  }

  // ── Equip decoration / effect ──────────────────────────────────────────

  async function equipCustomization(userId: string, input: EquipCustomizationInput) {
    const updates: Record<string, unknown> = {};

    if (input.avatarDecorationId !== undefined) {
      // Validate decoration exists if non-null
      if (input.avatarDecorationId) {
        const rows = await ctx.db
          .select({ id: avatarDecorations.id })
          .from(avatarDecorations)
          .where(
            and(
              eq(avatarDecorations.id, input.avatarDecorationId),
              eq(avatarDecorations.available, true),
            ),
          )
          .limit(1);
        if (rows.length === 0) {
          return { error: 'DECORATION_NOT_FOUND' };
        }
      }
      updates.avatarDecorationId = input.avatarDecorationId;
    }

    if (input.profileEffectId !== undefined) {
      if (input.profileEffectId) {
        const rows = await ctx.db
          .select({ id: profileEffects.id })
          .from(profileEffects)
          .where(
            and(
              eq(profileEffects.id, input.profileEffectId),
              eq(profileEffects.available, true),
            ),
          )
          .limit(1);
        if (rows.length === 0) {
          return { error: 'EFFECT_NOT_FOUND' };
        }
      }
      updates.profileEffectId = input.profileEffectId;
    }

    if (input.nameplateId !== undefined) {
      if (input.nameplateId) {
        const rows = await ctx.db
          .select({ id: nameplates.id })
          .from(nameplates)
          .where(
            and(
              eq(nameplates.id, input.nameplateId),
              eq(nameplates.available, true),
            ),
          )
          .limit(1);
        if (rows.length === 0) {
          return { error: 'NAMEPLATE_NOT_FOUND' };
        }
      }
      updates.nameplateId = input.nameplateId;
    }

    if (Object.keys(updates).length === 0) {
      return { error: 'NO_CHANGES' };
    }

    const [updated] = await ctx.db
      .update(userProfiles)
      .set(updates)
      .where(eq(userProfiles.userId, userId))
      .returning();

    return { profile: updated };
  }

  return {
    getMemberProfile,
    updateMemberProfile,
    updateMemberAvatar,
    updateMemberBanner,
    getAvatarDecorations,
    getProfileEffects,
    getNameplates,
    equipCustomization,
  };
}

export type ProfilesService = ReturnType<typeof createProfilesService>;
