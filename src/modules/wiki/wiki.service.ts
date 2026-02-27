import { eq, and, desc, lt, isNull, sql } from 'drizzle-orm';
import { wikiPages, wikiPageRevisions, channels } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import type { CreateWikiPageInput, UpdateWikiPageInput } from './wiki.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

export function createWikiService(ctx: AppContext) {
  async function createPage(
    channelId: string,
    guildId: string,
    authorId: string,
    input: CreateWikiPageInput,
  ) {
    // Validate channel is GUILD_WIKI
    const [channel] = await ctx.db
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, channelId));

    if (!channel || channel.type !== 'GUILD_WIKI') {
      return { error: 'INVALID_CHANNEL_TYPE' as const };
    }

    // Get next position
    const [posResult] = await ctx.db
      .select({ maxPos: sql<number>`coalesce(max(${wikiPages.position}), -1)::int` })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.channelId, channelId),
          input.parentPageId
            ? eq(wikiPages.parentPageId, input.parentPageId)
            : isNull(wikiPages.parentPageId),
        ),
      );

    const id = generateId();
    const [page] = await ctx.db
      .insert(wikiPages)
      .values({
        id,
        channelId,
        guildId,
        title: input.title,
        slug: slugify(input.title),
        content: input.content,
        authorId,
        parentPageId: input.parentPageId ?? null,
        pinned: input.pinned ?? false,
        position: (posResult?.maxPos ?? -1) + 1,
      })
      .returning();

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'WIKI_PAGE_CREATE',
      { guildId, channelId, page },
    );

    return page;
  }

  async function getPage(pageId: string) {
    const [page] = await ctx.db.select().from(wikiPages).where(eq(wikiPages.id, pageId));
    return page ?? null;
  }

  async function getPages(
    channelId: string,
    options: { parentPageId?: string; archived?: boolean },
  ) {
    const conditions = [eq(wikiPages.channelId, channelId)];

    if (options.parentPageId) {
      conditions.push(eq(wikiPages.parentPageId, options.parentPageId));
    } else if (options.parentPageId === undefined && !options.archived) {
      // Default: top-level pages only
      conditions.push(isNull(wikiPages.parentPageId));
    }

    if (options.archived !== undefined) {
      conditions.push(eq(wikiPages.archived, options.archived));
    } else {
      conditions.push(eq(wikiPages.archived, false));
    }

    return ctx.db
      .select()
      .from(wikiPages)
      .where(and(...conditions))
      .orderBy(desc(wikiPages.pinned), wikiPages.position);
  }

  async function updatePage(pageId: string, editorId: string, input: UpdateWikiPageInput) {
    const existing = await getPage(pageId);
    if (!existing) return { error: 'NOT_FOUND' as const };

    // Save current state as revision before updating
    if (input.content !== undefined || input.title !== undefined) {
      await ctx.db.insert(wikiPageRevisions).values({
        id: generateId(),
        pageId,
        content: existing.content,
        title: existing.title,
        editorId,
        editMessage: input.editMessage,
      });
    }

    const updates: Record<string, unknown> = {};
    if (input.title !== undefined) {
      updates['title'] = input.title;
      updates['slug'] = slugify(input.title);
    }
    if (input['content'] !== undefined) updates['content'] = input['content'];
    if (input['pinned'] !== undefined) updates['pinned'] = input['pinned'];
    if (input['archived'] !== undefined) updates['archived'] = input['archived'];
    if (input['parentPageId'] !== undefined) updates['parentPageId'] = input['parentPageId'];
    if (input['position'] !== undefined) updates['position'] = input['position'];

    if (input['content'] !== undefined || input.title !== undefined) {
      updates['lastEditorId'] = editorId;
      updates['editedAt'] = new Date();
    }

    const [updated] = await ctx.db
      .update(wikiPages)
      .set(updates)
      .where(eq(wikiPages.id, pageId))
      .returning();

    await emitRoomWithIntent(
      ctx.io,
      `guild:${updated.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'WIKI_PAGE_UPDATE',
      {
        guildId: updated.guildId,
        channelId: updated.channelId,
        page: updated,
      },
    );

    return updated;
  }

  async function deletePage(pageId: string) {
    const page = await getPage(pageId);
    if (!page) return { error: 'NOT_FOUND' as const };

    await ctx.db.delete(wikiPages).where(eq(wikiPages.id, pageId));

    await emitRoomWithIntent(
      ctx.io,
      `guild:${page.guildId}`,
      GatewayIntents.GUILD_MESSAGES,
      'WIKI_PAGE_DELETE',
      {
        guildId: page.guildId,
        channelId: page.channelId,
        pageId,
      },
    );

    return { success: true };
  }

  async function getRevisions(
    pageId: string,
    options: { limit: number; before?: string },
  ) {
    const conditions = [eq(wikiPageRevisions.pageId, pageId)];
    if (options.before) {
      conditions.push(lt(wikiPageRevisions.id, options.before));
    }

    return ctx.db
      .select()
      .from(wikiPageRevisions)
      .where(and(...conditions))
      .orderBy(desc(wikiPageRevisions.createdAt))
      .limit(options.limit);
  }

  async function revertToRevision(pageId: string, revisionId: string, editorId: string) {
    const [revision] = await ctx.db
      .select()
      .from(wikiPageRevisions)
      .where(and(eq(wikiPageRevisions.id, revisionId), eq(wikiPageRevisions.pageId, pageId)));

    if (!revision) return { error: 'REVISION_NOT_FOUND' as const };

    // Update page to revision content (this will also save current state as new revision via updatePage)
    return updatePage(pageId, editorId, {
      title: revision.title,
      content: revision.content,
      editMessage: `Reverted to revision ${revisionId}`,
    });
  }

  return {
    createPage,
    getPage,
    getPages,
    updatePage,
    deletePage,
    getRevisions,
    revertToRevision,
  };
}

export type WikiService = ReturnType<typeof createWikiService>;
