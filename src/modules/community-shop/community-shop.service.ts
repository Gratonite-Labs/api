import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import {
  communityItems,
  communityItemInstalls,
  communityItemReports,
} from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import type {
  BrowseCommunityItemsInput,
  CreateCommunityItemInput,
  InstallCommunityItemInput,
  ModerationDecisionInput,
  ReportCommunityItemInput,
} from './community-shop.schemas.js';

const PAYLOAD_MAX_BYTES = 20 * 1024;
const FORBIDDEN_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /expression\(/i,
  /onload\s*=/i,
  /onerror\s*=/i,
  /data:text\/html/i,
];

function isSafePayload(payload: Record<string, unknown>) {
  const json = JSON.stringify(payload);
  if (json.length > PAYLOAD_MAX_BYTES) return false;
  return !FORBIDDEN_PATTERNS.some((pattern) => pattern.test(json));
}

export function createCommunityShopService(ctx: AppContext) {
  function moderatorSet() {
    return new Set(
      ctx.env.COMMUNITY_SHOP_MODERATOR_IDS.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  function fail(code: 'FORBIDDEN' | 'UNSAFE_PAYLOAD' | 'INVALID_TRANSITION') {
    const error = new Error(code);
    error.name = code;
    throw error;
  }

  function assertModerator(userId: string) {
    if (!moderatorSet().has(userId)) {
      fail('FORBIDDEN');
    }
  }

  async function listItems(input: BrowseCommunityItemsInput, viewerUserId?: string | null) {
    const filters = [];
    const isMine = input.mine && Boolean(viewerUserId);
    const isModerator = viewerUserId ? moderatorSet().has(viewerUserId) : false;

    if (input.itemType) filters.push(eq(communityItems.itemType, input.itemType));
    if (input.search) filters.push(ilike(communityItems.name, `%${input.search}%`));

    if (input.status) {
      if (isMine || isModerator) filters.push(eq(communityItems.status, input.status));
      else filters.push(eq(communityItems.status, 'published'));
    } else if (!isMine && !isModerator) {
      filters.push(eq(communityItems.status, 'published'));
    }

    if (isMine && viewerUserId) {
      filters.push(eq(communityItems.uploaderId, viewerUserId));
    }

    const rows = await ctx.db
      .select({
        id: communityItems.id,
        itemType: communityItems.itemType,
        name: communityItems.name,
        description: communityItems.description,
        uploaderId: communityItems.uploaderId,
        payload: communityItems.payload,
        payloadSchemaVersion: communityItems.payloadSchemaVersion,
        assetHash: communityItems.assetHash,
        tags: communityItems.tags,
        status: communityItems.status,
        moderationNotes: communityItems.moderationNotes,
        rejectionCode: communityItems.rejectionCode,
        publishedAt: communityItems.publishedAt,
        createdAt: communityItems.createdAt,
        updatedAt: communityItems.updatedAt,
        installCount: sql<number>`(select count(*)::int from ${communityItemInstalls} i where i.item_id = ${communityItems.id})`,
      })
      .from(communityItems)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(communityItems.publishedAt), desc(communityItems.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    return rows;
  }

  async function createItem(userId: string, input: CreateCommunityItemInput) {
    if (!isSafePayload(input.payload)) {
      fail('UNSAFE_PAYLOAD');
    }

    const id = generateId();
    await ctx.db.insert(communityItems).values({
      id,
      itemType: input.itemType,
      name: input.name,
      description: input.description ?? null,
      uploaderId: userId,
      payload: input.payload,
      payloadSchemaVersion: input.payloadSchemaVersion,
      assetHash: input.assetHash ?? null,
      tags: input.tags,
      status: 'draft',
    });

    const [created] = await ctx.db
      .select()
      .from(communityItems)
      .where(eq(communityItems.id, id))
      .limit(1);
    return created ?? null;
  }

  async function submitForReview(itemId: string, userId: string) {
    const [item] = await ctx.db
      .select()
      .from(communityItems)
      .where(and(eq(communityItems.id, itemId), eq(communityItems.uploaderId, userId)))
      .limit(1);
    if (!item) return null;

    if (!isSafePayload((item.payload ?? {}) as Record<string, unknown>)) {
      fail('UNSAFE_PAYLOAD');
    }

    await ctx.db
      .update(communityItems)
      .set({
        status: 'pending_review',
        moderationNotes: null,
        rejectionCode: null,
        updatedAt: new Date(),
      })
      .where(eq(communityItems.id, itemId));

    const [updated] = await ctx.db
      .select()
      .from(communityItems)
      .where(eq(communityItems.id, itemId))
      .limit(1);
    return updated ?? null;
  }

  async function getModerationQueue(userId: string, limit = 50) {
    assertModerator(userId);
    return ctx.db
      .select()
      .from(communityItems)
      .where(eq(communityItems.status, 'pending_review'))
      .orderBy(desc(communityItems.createdAt))
      .limit(limit);
  }

  async function moderateItem(itemId: string, userId: string, input: ModerationDecisionInput) {
    assertModerator(userId);

    const [existing] = await ctx.db
      .select()
      .from(communityItems)
      .where(eq(communityItems.id, itemId))
      .limit(1);
    if (!existing) return null;

    const currentStatus = existing.status;
    let status: 'approved' | 'published' | 'rejected' | 'unpublished' = 'approved';
    let publishedAt: Date | null = existing.publishedAt ?? null;
    if (input.action === 'approve') {
      if (currentStatus !== 'pending_review') fail('INVALID_TRANSITION');
      status = 'approved';
    }
    if (input.action === 'publish') {
      if (currentStatus !== 'approved' && currentStatus !== 'pending_review') fail('INVALID_TRANSITION');
      status = 'published';
      publishedAt = new Date();
    }
    if (input.action === 'reject') {
      if (currentStatus !== 'pending_review' && currentStatus !== 'approved') fail('INVALID_TRANSITION');
      status = 'rejected';
      publishedAt = null;
    }
    if (input.action === 'unpublish') {
      if (currentStatus !== 'published') fail('INVALID_TRANSITION');
      status = 'unpublished';
      publishedAt = null;
    }

    await ctx.db
      .update(communityItems)
      .set({
        status,
        rejectionCode: status === 'rejected' ? (input.rejectionCode ?? null) : null,
        moderationNotes: input.notes ?? null,
        publishedAt,
        updatedAt: new Date(),
      })
      .where(eq(communityItems.id, itemId));

    const [updated] = await ctx.db
      .select()
      .from(communityItems)
      .where(eq(communityItems.id, itemId))
      .limit(1);
    return updated ?? null;
  }

  async function installItem(userId: string, itemId: string, input: InstallCommunityItemInput) {
    const [item] = await ctx.db
      .select({ id: communityItems.id, status: communityItems.status })
      .from(communityItems)
      .where(eq(communityItems.id, itemId))
      .limit(1);
    if (!item || item.status !== 'published') return null;

    const scopeId = input.scope === 'guild' ? (input.scopeId ?? null) : null;
    const scopeCondition =
      scopeId === null
        ? isNull(communityItemInstalls.scopeId)
        : eq(communityItemInstalls.scopeId, scopeId);

    await ctx.db
      .delete(communityItemInstalls)
      .where(
        and(
          eq(communityItemInstalls.userId, userId),
          eq(communityItemInstalls.itemId, itemId),
          eq(communityItemInstalls.scope, input.scope),
          scopeCondition,
        ),
      );

    await ctx.db.insert(communityItemInstalls).values({
      userId,
      itemId,
      scope: input.scope,
      scopeId,
    });

    return { userId, itemId, scope: input.scope, scopeId };
  }

  async function uninstallItem(userId: string, itemId: string, input: InstallCommunityItemInput) {
    const scopeId = input.scope === 'guild' ? (input.scopeId ?? null) : null;
    const scopeCondition =
      scopeId === null
        ? isNull(communityItemInstalls.scopeId)
        : eq(communityItemInstalls.scopeId, scopeId);

    const deleted = await ctx.db
      .delete(communityItemInstalls)
      .where(
        and(
          eq(communityItemInstalls.userId, userId),
          eq(communityItemInstalls.itemId, itemId),
          eq(communityItemInstalls.scope, input.scope),
          scopeCondition,
        ),
      )
      .returning({ itemId: communityItemInstalls.itemId });
    return deleted.length > 0;
  }

  async function reportItem(userId: string, itemId: string, input: ReportCommunityItemInput) {
    const [item] = await ctx.db
      .select({ id: communityItems.id })
      .from(communityItems)
      .where(eq(communityItems.id, itemId))
      .limit(1);
    if (!item) return null;

    const id = generateId();
    await ctx.db.insert(communityItemReports).values({
      id,
      itemId,
      reporterId: userId,
      reason: input.reason,
      details: input.details ?? null,
      status: 'open',
    });

    const [report] = await ctx.db
      .select()
      .from(communityItemReports)
      .where(eq(communityItemReports.id, id))
      .limit(1);
    return report ?? null;
  }

  async function getMyItems(userId: string) {
    const [created, installed] = await Promise.all([
      ctx.db
        .select()
        .from(communityItems)
        .where(eq(communityItems.uploaderId, userId))
        .orderBy(desc(communityItems.createdAt))
        .limit(100),
      ctx.db
        .select({
          itemId: communityItemInstalls.itemId,
          scope: communityItemInstalls.scope,
          scopeId: communityItemInstalls.scopeId,
          installedAt: communityItemInstalls.installedAt,
        })
        .from(communityItemInstalls)
        .where(eq(communityItemInstalls.userId, userId))
        .orderBy(desc(communityItemInstalls.installedAt))
        .limit(200),
    ]);

    return { created, installed };
  }

  return {
    listItems,
    createItem,
    submitForReview,
    getModerationQueue,
    moderateItem,
    installItem,
    uninstallItem,
    reportItem,
    getMyItems,
  };
}
