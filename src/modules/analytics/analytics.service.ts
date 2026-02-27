import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { serverAnalyticsDaily, serverAnalyticsHourly } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';

function dateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function hourKey(d = new Date()): string {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

export function createAnalyticsService(ctx: AppContext) {
  // ── Tracking (fire-and-forget from routers) ───────────────────────────

  async function trackMessage(guildId: string, channelId: string, userId: string) {
    const dk = dateKey();
    const hk = hourKey();

    const pipeline = ctx.redis.pipeline();
    pipeline.hincrby(`analytics:daily:${guildId}:${dk}`, 'messages_sent', 1);
    pipeline.expire(`analytics:daily:${guildId}:${dk}`, 172800); // 48h
    pipeline.hincrby(`analytics:hourly:${guildId}:${hk}`, 'messages', 1);
    pipeline.expire(`analytics:hourly:${guildId}:${hk}`, 172800);
    pipeline.hincrby(`analytics:daily:${guildId}:${dk}:channels`, channelId, 1);
    pipeline.expire(`analytics:daily:${guildId}:${dk}:channels`, 172800);
    pipeline.pfadd(`analytics:daily:${guildId}:${dk}:active`, userId);
    pipeline.expire(`analytics:daily:${guildId}:${dk}:active`, 172800);
    await pipeline.exec();
  }

  async function trackMemberJoin(guildId: string) {
    const dk = dateKey();
    await ctx.redis.hincrby(`analytics:daily:${guildId}:${dk}`, 'new_members', 1);
    await ctx.redis.expire(`analytics:daily:${guildId}:${dk}`, 172800);
  }

  async function trackMemberLeave(guildId: string) {
    const dk = dateKey();
    await ctx.redis.hincrby(`analytics:daily:${guildId}:${dk}`, 'left_members', 1);
    await ctx.redis.expire(`analytics:daily:${guildId}:${dk}`, 172800);
  }

  async function trackReaction(guildId: string) {
    const dk = dateKey();
    await ctx.redis.hincrby(`analytics:daily:${guildId}:${dk}`, 'reactions_added', 1);
    await ctx.redis.expire(`analytics:daily:${guildId}:${dk}`, 172800);
  }

  // ── Flush (background job) ────────────────────────────────────────────

  async function flushAnalytics() {
    // Scan for daily analytics keys
    let cursor = '0';
    const dailyKeys: string[] = [];
    const hourlyKeys: string[] = [];

    do {
      const [nextCursor, keys] = await ctx.redis.scan(
        cursor,
        'MATCH',
        'analytics:daily:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        // Skip channel and active sub-keys
        if (key.includes(':channels') || key.includes(':active')) continue;
        dailyKeys.push(key);
      }
    } while (cursor !== '0');

    do {
      const [nextCursor, keys] = await ctx.redis.scan(
        cursor,
        'MATCH',
        'analytics:hourly:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      hourlyKeys.push(...keys);
    } while (cursor !== '0');

    // Flush daily
    for (const key of dailyKeys) {
      try {
        // Key format: analytics:daily:{guildId}:{YYYY-MM-DD}
        const parts = key.split(':');
        const guildId = parts[2];
        const date = parts[3];
        if (!guildId || !date) continue;

        const data = await ctx.redis.hgetall(key);
        if (!Object.keys(data).length) continue;

        // Get active members count from HyperLogLog
        const activeKey = `analytics:daily:${guildId}:${date}:active`;
        const activeCount = await ctx.redis.pfcount(activeKey);

        // Get top channels
        const channelsKey = `analytics:daily:${guildId}:${date}:channels`;
        const channelData = await ctx.redis.hgetall(channelsKey);
        const topChannels = Object.entries(channelData)
          .map(([channelId, count]) => ({ channelId, messageCount: parseInt(count, 10) }))
          .sort((a, b) => b.messageCount - a.messageCount)
          .slice(0, 10);

        const dateSql = `${date}`;

        // Upsert using raw SQL for ON CONFLICT
        await ctx.db.execute(sql`
          INSERT INTO server_analytics_daily (guild_id, date, messages_sent, new_members, left_members, active_members, reactions_added, top_channels, total_members, voice_minutes)
          VALUES (${guildId}, ${dateSql}::date, ${parseInt(data.messages_sent || '0', 10)}, ${parseInt(data.new_members || '0', 10)}, ${parseInt(data.left_members || '0', 10)}, ${activeCount}, ${parseInt(data.reactions_added || '0', 10)}, ${JSON.stringify(topChannels)}::jsonb, 0, 0)
          ON CONFLICT (guild_id, date) DO UPDATE SET
            messages_sent = server_analytics_daily.messages_sent + EXCLUDED.messages_sent,
            new_members = server_analytics_daily.new_members + EXCLUDED.new_members,
            left_members = server_analytics_daily.left_members + EXCLUDED.left_members,
            active_members = EXCLUDED.active_members,
            reactions_added = server_analytics_daily.reactions_added + EXCLUDED.reactions_added,
            top_channels = EXCLUDED.top_channels
        `);

        // Clean up Redis keys after flush
        await ctx.redis.del(key);
        await ctx.redis.del(activeKey);
        await ctx.redis.del(channelsKey);
      } catch (err) {
        logger.warn({ err, key }, 'Failed to flush daily analytics key');
      }
    }

    // Flush hourly
    for (const key of hourlyKeys) {
      try {
        // Key format: analytics:hourly:{guildId}:{YYYY-MM-DDTHH}
        const parts = key.split(':');
        const guildId = parts[2];
        const hourStr = parts[3];
        if (!guildId || !hourStr) continue;

        const data = await ctx.redis.hgetall(key);
        if (!Object.keys(data).length) continue;

        const hourSql = `${hourStr}:00:00Z`;

        await ctx.db.execute(sql`
          INSERT INTO server_analytics_hourly (guild_id, hour, messages, active_users, voice_users)
          VALUES (${guildId}, ${hourSql}::timestamptz, ${parseInt(data.messages || '0', 10)}, ${parseInt(data.active_users || '0', 10)}, ${parseInt(data.voice_users || '0', 10)})
          ON CONFLICT (guild_id, hour) DO UPDATE SET
            messages = server_analytics_hourly.messages + EXCLUDED.messages,
            active_users = greatest(server_analytics_hourly.active_users, EXCLUDED.active_users),
            voice_users = greatest(server_analytics_hourly.voice_users, EXCLUDED.voice_users)
        `);

        await ctx.redis.del(key);
      } catch (err) {
        logger.warn({ err, key }, 'Failed to flush hourly analytics key');
      }
    }

    if (dailyKeys.length || hourlyKeys.length) {
      logger.info(
        { dailyKeys: dailyKeys.length, hourlyKeys: hourlyKeys.length },
        'Analytics flushed',
      );
    }
  }

  async function cleanupOldHourlyData() {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const result = await ctx.db
      .delete(serverAnalyticsHourly)
      .where(lte(serverAnalyticsHourly.hour, cutoff));
    logger.info('Cleaned up old hourly analytics data');
  }

  // ── Query ─────────────────────────────────────────────────────────────

  async function getDailyAnalytics(guildId: string, period: string) {
    const days = parseInt(period) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    return ctx.db
      .select()
      .from(serverAnalyticsDaily)
      .where(
        and(
          eq(serverAnalyticsDaily.guildId, guildId),
          gte(serverAnalyticsDaily.date, since),
        ),
      )
      .orderBy(serverAnalyticsDaily.date);
  }

  async function getHourlyHeatmap(guildId: string, days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    return ctx.db
      .select()
      .from(serverAnalyticsHourly)
      .where(
        and(
          eq(serverAnalyticsHourly.guildId, guildId),
          gte(serverAnalyticsHourly.hour, since),
        ),
      )
      .orderBy(serverAnalyticsHourly.hour);
  }

  return {
    trackMessage,
    trackMemberJoin,
    trackMemberLeave,
    trackReaction,
    flushAnalytics,
    cleanupOldHourlyData,
    getDailyAnalytics,
    getHourlyHeatmap,
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
