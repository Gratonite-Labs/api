import { eq } from 'drizzle-orm';
import { guildBrand, guildCustomCss } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';
import type { UpdateBrandInput } from './brand.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

const BRAND_CACHE_TTL = 120; // seconds

export function createBrandService(ctx: AppContext) {
  // ── Brand ──────────────────────────────────────────────────────────────

  async function getBrand(guildId: string) {
    // Check Redis cache first
    const cacheKey = `guild_brand:${guildId}`;
    const cached = await ctx.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const rows = await ctx.db
      .select()
      .from(guildBrand)
      .where(eq(guildBrand.guildId, guildId))
      .limit(1);

    const brand = rows[0] || null;
    if (brand) {
      await ctx.redis.set(cacheKey, JSON.stringify(brand), 'EX', BRAND_CACHE_TTL);
    }

    return brand;
  }

  async function updateBrand(guildId: string, input: UpdateBrandInput) {
    const updates: Record<string, unknown> = {};
    if (input.colorPrimary !== undefined) updates.colorPrimary = input.colorPrimary;
    if (input.colorSecondary !== undefined) updates.colorSecondary = input.colorSecondary;
    if (input.colorAccent !== undefined) updates.colorAccent = input.colorAccent;
    if (input.gradientType !== undefined) updates.gradientType = input.gradientType;
    if (input.gradientConfig !== undefined) updates.gradientConfig = input.gradientConfig;
    if (input.backgroundBlur !== undefined) updates.backgroundBlur = input.backgroundBlur;
    if (input.fontDisplay !== undefined) updates.fontDisplay = input.fontDisplay;
    if (input.fontBody !== undefined) updates.fontBody = input.fontBody;
    if (input.iconPack !== undefined) updates.iconPack = input.iconPack;
    if (input.noiseOpacity !== undefined) updates.noiseOpacity = input.noiseOpacity;
    if (input.glassOpacity !== undefined) updates.glassOpacity = input.glassOpacity;
    if (input.cornerStyle !== undefined) updates.cornerStyle = input.cornerStyle;
    if (input.messageLayout !== undefined) updates.messageLayout = input.messageLayout;

    const [updated] = await ctx.db
      .update(guildBrand)
      .set(updates)
      .where(eq(guildBrand.guildId, guildId))
      .returning();

    if (updated) {
      // Invalidate cache
      await ctx.redis.del(`guild_brand:${guildId}`);

      // Emit real-time event
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_BRAND_UPDATE',
        {
          guildId,
          brand: updated,
        },
      );
    }

    return updated || null;
  }

  async function updateBackgroundImage(guildId: string, hash: string | null) {
    const [updated] = await ctx.db
      .update(guildBrand)
      .set({ backgroundImageHash: hash })
      .where(eq(guildBrand.guildId, guildId))
      .returning();

    if (updated) {
      await ctx.redis.del(`guild_brand:${guildId}`);
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_BRAND_UPDATE',
        {
          guildId,
          brand: updated,
        },
      );
    }

    return updated || null;
  }

  // ── Custom CSS ─────────────────────────────────────────────────────────

  async function getCustomCss(guildId: string) {
    const rows = await ctx.db
      .select()
      .from(guildCustomCss)
      .where(eq(guildCustomCss.guildId, guildId))
      .limit(1);

    return rows[0] || null;
  }

  async function updateCustomCss(guildId: string, userId: string, css: string) {
    await ctx.db
      .insert(guildCustomCss)
      .values({
        guildId,
        css,
        updatedAt: new Date(),
        updatedBy: userId,
      })
      .onConflictDoUpdate({
        target: guildCustomCss.guildId,
        set: {
          css,
          updatedAt: new Date(),
          updatedBy: userId,
        },
      });

    // Re-read to return clean data
    const row = await getCustomCss(guildId);

    if (row) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_CSS_UPDATE',
        {
          guildId,
          css: row,
        },
      );
    }

    return row;
  }

  return {
    getBrand,
    updateBrand,
    updateBackgroundImage,
    getCustomCss,
    updateCustomCss,
  };
}

export type BrandService = ReturnType<typeof createBrandService>;
