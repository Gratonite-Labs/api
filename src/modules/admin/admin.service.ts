import { eq } from 'drizzle-orm';
import { shopItems } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import sharp from 'sharp';

const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES ?? 'ferdinand').split(',').map((s) => s.trim()).filter(Boolean),
);

export function createAdminService(ctx: AppContext) {
  function isAdmin(username: string): boolean {
    return ADMIN_USERNAMES.has(username);
  }

  async function updateShopItem(
    id: string,
    updates: {
      name?: string;
      description?: string;
      price?: number;
      isActive?: boolean;
      isFeatured?: boolean;
      sortOrder?: number;
      category?: string;
    },
  ) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.price !== undefined) updateData.price = updates.price;
    if (updates.isActive !== undefined) updateData.isActive = updates.isActive;
    if (updates.isFeatured !== undefined) updateData.isFeatured = updates.isFeatured;
    if (updates.sortOrder !== undefined) updateData.sortOrder = updates.sortOrder;
    if (updates.category !== undefined) updateData.category = updates.category;

    const [updated] = await ctx.db
      .update(shopItems)
      .set(updateData)
      .where(eq(shopItems.id, id))
      .returning();

    if (!updated) throw new Error('ITEM_NOT_FOUND');
    return updated;
  }

  async function createShopItem(input: {
    name: string;
    description?: string;
    type: string;
    category: string;
    price: number;
  }) {
    const id = generateId();
    const [created] = await ctx.db
      .insert(shopItems)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        type: input.type,
        category: input.category,
        price: input.price,
        isActive: true,
        isFeatured: false,
        sortOrder: 0,
      })
      .returning();

    return created;
  }

  async function deleteShopItem(id: string) {
    const [updated] = await ctx.db
      .update(shopItems)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(shopItems.id, id))
      .returning();

    if (!updated) throw new Error('ITEM_NOT_FOUND');
    return updated;
  }

  async function uploadShopAsset(id: string, file: Buffer, mimetype: string) {
    // Verify item exists
    const [item] = await ctx.db
      .select()
      .from(shopItems)
      .where(eq(shopItems.id, id))
      .limit(1);

    if (!item) throw new Error('ITEM_NOT_FOUND');

    // Determine dimensions by type
    let width = 256;
    let height = 256;
    if (item.type === 'profile_effect') {
      width = 400;
      height = 240;
    } else if (item.type === 'nameplate') {
      width = 400;
      height = 48;
    }

    // Process image with sharp
    const processed = await sharp(file)
      .resize(width, height, { fit: 'cover' })
      .webp({ quality: 90 })
      .toBuffer();

    const assetKey = `shop-${id}.webp`;

    // Upload to MinIO
    await ctx.minio.putObject('avatars', `cosmetics/${assetKey}`, processed, processed.length, {
      'Content-Type': 'image/webp',
    });

    // Update DB
    await ctx.db
      .update(shopItems)
      .set({ assetHash: assetKey, updatedAt: new Date() })
      .where(eq(shopItems.id, id));

    return assetKey;
  }

  return {
    isAdmin,
    updateShopItem,
    createShopItem,
    deleteShopItem,
    uploadShopAsset,
  };
}
