import { and, desc, eq, count, sql } from 'drizzle-orm';
import { cosmetics, cosmeticPurchases } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { createEconomyService } from '../economy/economy.service.js';

export type CosmeticType = 'avatar_decoration' | 'effect' | 'nameplate' | 'soundboard';

export interface CreateCosmeticInput {
  name: string;
  description?: string;
  type: CosmeticType;
  previewImageUrl?: string;
  assetUrl?: string;
  price?: number;
}

export interface UpdateCosmeticInput {
  name?: string;
  description?: string;
  previewImageUrl?: string;
  assetUrl?: string;
  price?: number;
  isPublished?: boolean;
}

function error(code: string): never {
  throw Object.assign(new Error(code), { code });
}

export function createCosmeticsService(ctx: AppContext) {
  const economyService = createEconomyService(ctx);

  // ── Create a draft cosmetic ──────────────────────────────────────────────
  async function createCosmetic(creatorId: string, input: CreateCosmeticInput) {
    const id = generateId();
    const [cosmetic] = await ctx.db
      .insert(cosmetics)
      .values({
        id,
        creatorId,
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        previewImageUrl: input.previewImageUrl ?? null,
        assetUrl: input.assetUrl ?? null,
        price: input.price ?? 0,
        isPublished: false,
      })
      .returning();
    return cosmetic;
  }

  // ── Get a single cosmetic by id ──────────────────────────────────────────
  async function getCosmetic(id: string) {
    const [cosmetic] = await ctx.db
      .select()
      .from(cosmetics)
      .where(eq(cosmetics.id, id))
      .limit(1);
    if (!cosmetic) error('NOT_FOUND');
    return cosmetic;
  }

  // ── Update a cosmetic (creator only) ────────────────────────────────────
  async function updateCosmetic(
    id: string,
    requestorId: string,
    input: UpdateCosmeticInput,
  ) {
    const existing = await getCosmetic(id);
    if (existing.creatorId !== requestorId) error('FORBIDDEN');

    const [updated] = await ctx.db
      .update(cosmetics)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.previewImageUrl !== undefined && { previewImageUrl: input.previewImageUrl }),
        ...(input.assetUrl !== undefined && { assetUrl: input.assetUrl }),
        ...(input.price !== undefined && { price: input.price }),
        ...(input.isPublished !== undefined && { isPublished: input.isPublished }),
        updatedAt: new Date(),
      })
      .where(eq(cosmetics.id, id))
      .returning();
    return updated;
  }

  // ── Delete a cosmetic (creator only, unpublished only) ───────────────────
  async function deleteCosmetic(id: string, requestorId: string) {
    const existing = await getCosmetic(id);
    if (existing.creatorId !== requestorId) error('FORBIDDEN');
    if (existing.isPublished) error('CANNOT_DELETE_PUBLISHED');

    await ctx.db.delete(cosmetics).where(eq(cosmetics.id, id));
  }

  // ── List published cosmetics by creator ──────────────────────────────────
  async function listByCreator(creatorId: string, limit = 20, offset = 0) {
    return ctx.db
      .select()
      .from(cosmetics)
      .where(and(eq(cosmetics.creatorId, creatorId), eq(cosmetics.isPublished, true)))
      .orderBy(desc(cosmetics.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // ── List all cosmetics for the authenticated creator (drafts + published) ─
  async function listMine(creatorId: string) {
    return ctx.db
      .select()
      .from(cosmetics)
      .where(eq(cosmetics.creatorId, creatorId))
      .orderBy(desc(cosmetics.createdAt));
  }

  // ── List all published cosmetics (marketplace browse) ────────────────────
  async function listPublished(
    opts: { type?: CosmeticType; limit?: number; offset?: number } = {},
  ) {
    const { type, limit = 20, offset = 0 } = opts;
    return ctx.db
      .select()
      .from(cosmetics)
      .where(
        and(
          eq(cosmetics.isPublished, true),
          type ? eq(cosmetics.type, type) : undefined,
        ),
      )
      .orderBy(desc(cosmetics.createdAt))
      .limit(limit)
      .offset(offset);
  }

  // ── Purchase a cosmetic ──────────────────────────────────────────────────
  async function purchaseCosmetic(userId: string, cosmeticId: string) {
    const cosmetic = await getCosmetic(cosmeticId);
    if (!cosmetic.isPublished) error('NOT_AVAILABLE');

    // Check already owned
    const [existing] = await ctx.db
      .select()
      .from(cosmeticPurchases)
      .where(
        and(
          eq(cosmeticPurchases.userId, userId),
          eq(cosmeticPurchases.cosmeticId, cosmeticId),
        ),
      )
      .limit(1);
    if (existing) error('ALREADY_OWNED');

    // Deduct wallet atomically
    if (cosmetic.price > 0) {
      await economyService.spendCurrency(userId, {
        amount: cosmetic.price,
        source: 'creator_item_purchase',
        description: `Purchased cosmetic: ${cosmetic.name}`,
        contextKey: `cosmetic:${cosmeticId}`,
      });
    }

    const id = generateId();
    const [purchase] = await ctx.db
      .insert(cosmeticPurchases)
      .values({ id, userId, cosmeticId, isEquipped: false })
      .returning();
    return { purchase, cosmetic };
  }

  // ── Equip a cosmetic ─────────────────────────────────────────────────────
  async function equipCosmetic(userId: string, cosmeticId: string) {
    // Verify ownership
    const [purchase] = await ctx.db
      .select()
      .from(cosmeticPurchases)
      .where(
        and(
          eq(cosmeticPurchases.userId, userId),
          eq(cosmeticPurchases.cosmeticId, cosmeticId),
        ),
      )
      .limit(1);
    if (!purchase) error('NOT_OWNED');

    const cosmetic = await getCosmetic(cosmeticId);

    // Unequip any other cosmetic of the same type first
    const allOfType = await ctx.db
      .select({ p: cosmeticPurchases, c: cosmetics })
      .from(cosmeticPurchases)
      .innerJoin(cosmetics, eq(cosmeticPurchases.cosmeticId, cosmetics.id))
      .where(
        and(
          eq(cosmeticPurchases.userId, userId),
          eq(cosmetics.type, cosmetic.type),
          eq(cosmeticPurchases.isEquipped, true),
        ),
      );

    if (allOfType.length > 0) {
      await ctx.db
        .update(cosmeticPurchases)
        .set({ isEquipped: false })
        .where(
          and(
            eq(cosmeticPurchases.userId, userId),
            sql`${cosmeticPurchases.cosmeticId} IN (
              SELECT cp.cosmetic_id FROM cosmetic_purchases cp
              INNER JOIN cosmetics c ON cp.cosmetic_id = c.id
              WHERE cp.user_id = ${userId} AND c.type = ${cosmetic.type} AND cp.is_equipped = true
            )`,
          ),
        );
    }

    const [updated] = await ctx.db
      .update(cosmeticPurchases)
      .set({ isEquipped: true })
      .where(
        and(
          eq(cosmeticPurchases.userId, userId),
          eq(cosmeticPurchases.cosmeticId, cosmeticId),
        ),
      )
      .returning();
    return updated;
  }

  // ── Unequip a cosmetic ───────────────────────────────────────────────────
  async function unequipCosmetic(userId: string, cosmeticId: string) {
    const [purchase] = await ctx.db
      .select()
      .from(cosmeticPurchases)
      .where(
        and(
          eq(cosmeticPurchases.userId, userId),
          eq(cosmeticPurchases.cosmeticId, cosmeticId),
        ),
      )
      .limit(1);
    if (!purchase) error('NOT_OWNED');

    const [updated] = await ctx.db
      .update(cosmeticPurchases)
      .set({ isEquipped: false })
      .where(
        and(
          eq(cosmeticPurchases.userId, userId),
          eq(cosmeticPurchases.cosmeticId, cosmeticId),
        ),
      )
      .returning();
    return updated;
  }

  // ── Get equipped cosmetics for a user ────────────────────────────────────
  async function getEquipped(userId: string) {
    return ctx.db
      .select({
        type: cosmetics.type,
        cosmeticId: cosmetics.id,
        name: cosmetics.name,
        assetUrl: cosmetics.assetUrl,
        previewImageUrl: cosmetics.previewImageUrl,
      })
      .from(cosmeticPurchases)
      .innerJoin(cosmetics, eq(cosmeticPurchases.cosmeticId, cosmetics.id))
      .where(
        and(
          eq(cosmeticPurchases.userId, userId),
          eq(cosmeticPurchases.isEquipped, true),
        ),
      );
  }

  // ── Get stats for a cosmetic (creator only) ──────────────────────────────
  async function getCosmeticStats(id: string, requestorId: string) {
    const cosmetic = await getCosmetic(id);
    if (cosmetic.creatorId !== requestorId) error('FORBIDDEN');

    const [stats] = await ctx.db
      .select({ totalSales: count() })
      .from(cosmeticPurchases)
      .where(eq(cosmeticPurchases.cosmeticId, id));

    const totalSales = stats?.totalSales ?? 0;
    return {
      cosmeticId: id,
      totalSales,
      totalRevenueGratonites: totalSales * cosmetic.price,
      createdAt: cosmetic.createdAt,
      updatedAt: cosmetic.updatedAt,
    };
  }

  return {
    createCosmetic,
    getCosmetic,
    updateCosmetic,
    deleteCosmetic,
    listByCreator,
    listMine,
    listPublished,
    purchaseCosmetic,
    equipCosmetic,
    unequipCosmetic,
    getEquipped,
    getCosmeticStats,
  };
}
