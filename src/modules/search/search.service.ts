import { sql } from 'drizzle-orm';
import type { AppContext } from '../../lib/context.js';
import type { SearchMessagesInput } from './search.schemas.js';
import { relationships } from '@gratonite/db';

export function createSearchService(ctx: AppContext) {
  async function searchMessages(userId: string, params: SearchMessagesInput) {
    const { query, guildId, channelId, authorId, before, after, limit, offset } = params;

    // Build dynamic WHERE conditions
    const conditions: ReturnType<typeof sql>[] = [
      sql`m.search_vector @@ plainto_tsquery('english', ${query})`,
      sql`m.deleted_at IS NULL`,
      sql`NOT EXISTS (
        SELECT 1
        FROM ${relationships} r
        WHERE r.type = 'blocked'
          AND (
            (r.user_id = ${userId} AND r.target_id = m.author_id)
            OR
            (r.target_id = ${userId} AND r.user_id = m.author_id)
          )
      )`,
    ];

    if (channelId) {
      conditions.push(sql`m.channel_id = ${channelId}`);
    }
    if (guildId) {
      conditions.push(sql`m.guild_id = ${guildId}`);
    }
    if (authorId) {
      conditions.push(sql`m.author_id = ${authorId}`);
    }
    if (before) {
      conditions.push(sql`m.id < ${before}`);
    }
    if (after) {
      conditions.push(sql`m.id > ${after}`);
    }

    const whereClause = sql.join(conditions, sql` AND `);

    const results = await ctx.db.execute(sql`
      SELECT
        m.id,
        m.channel_id AS "channelId",
        m.guild_id AS "guildId",
        m.author_id AS "authorId",
        m.content,
        m.type,
        m.created_at AS "createdAt",
        ts_headline('english', m.content, plainto_tsquery('english', ${query}),
          'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=30') AS highlight,
        ts_rank(m.search_vector, plainto_tsquery('english', ${query})) AS rank
      FROM messages m
      WHERE ${whereClause}
      ORDER BY rank DESC, m.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    // Get total count for pagination
    const countResult = await ctx.db.execute(sql`
      SELECT count(*)::int AS total
      FROM messages m
      WHERE ${whereClause}
    `);

    const total = (countResult[0] as any)?.total ?? 0;

    return {
      results: results as unknown as Array<{
        id: string;
        channelId: string;
        guildId: string | null;
        authorId: string;
        content: string;
        type: number;
        createdAt: string;
        highlight: string;
        rank: number;
      }>,
      total,
      limit,
      offset,
    };
  }

  return { searchMessages };
}

export type SearchService = ReturnType<typeof createSearchService>;
