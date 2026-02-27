import { eq, and, desc, lt, gte, sql, count } from 'drizzle-orm';
import {
  raidConfig,
  reports,
  autoModRules,
  autoModActionLogs,
  auditLogEntries,
  bans,
} from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';
import type {
  UpdateRaidConfigInput,
  CreateReportInput,
  UpdateReportInput,
} from './moderation.schemas.js';

export function createModerationService(ctx: AppContext) {
  // ── Raid Protection ─────────────────────────────────────────────────────

  async function getRaidConfig(guildId: string) {
    const [config] = await ctx.db
      .select()
      .from(raidConfig)
      .where(eq(raidConfig.guildId, guildId));

    return (
      config ?? {
        guildId,
        enabled: false,
        joinThreshold: 10,
        joinWindowSeconds: 60,
        action: 'alert_only' as const,
        autoResolveMinutes: 30,
        updatedAt: new Date().toISOString(),
      }
    );
  }

  async function updateRaidConfig(guildId: string, input: UpdateRaidConfigInput) {
    const values: Record<string, unknown> = { guildId, updatedAt: new Date() };
    if (input.enabled !== undefined) values.enabled = input.enabled;
    if (input.joinThreshold !== undefined) values.joinThreshold = input.joinThreshold;
    if (input.joinWindowSeconds !== undefined) values.joinWindowSeconds = input.joinWindowSeconds;
    if (input.action !== undefined) values.action = input.action;
    if (input.autoResolveMinutes !== undefined)
      values.autoResolveMinutes = input.autoResolveMinutes;

    // Upsert
    const [existing] = await ctx.db
      .select()
      .from(raidConfig)
      .where(eq(raidConfig.guildId, guildId));

    let result;
    if (existing) {
      delete values.guildId;
      [result] = await ctx.db
        .update(raidConfig)
        .set(values)
        .where(eq(raidConfig.guildId, guildId))
        .returning();
    } else {
      // Set defaults for missing fields on insert
      values.enabled = values.enabled ?? false;
      values.joinThreshold = values.joinThreshold ?? 10;
      values.joinWindowSeconds = values.joinWindowSeconds ?? 60;
      values.action = values.action ?? 'alert_only';
      values.autoResolveMinutes = values.autoResolveMinutes ?? 30;
      [result] = await ctx.db.insert(raidConfig).values(values as any).returning();
    }

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_UPDATE',
      { id: guildId } as any,
    );
    return result;
  }

  async function checkMemberJoin(guildId: string, userId: string) {
    // Fetch config from Redis cache or DB
    const cacheKey = `raid_config:${guildId}`;
    let config: Awaited<ReturnType<typeof getRaidConfig>>;

    const cached = await ctx.redis.get(cacheKey);
    if (cached) {
      try {
        config = JSON.parse(cached);
      } catch {
        config = await getRaidConfig(guildId);
      }
    } else {
      config = await getRaidConfig(guildId);
      await ctx.redis.set(cacheKey, JSON.stringify(config), 'EX', 120);
    }

    if (!config.enabled) return;

    const now = Date.now();
    const monitorKey = `raid_monitor:${guildId}`;
    const windowMs = config.joinWindowSeconds * 1000;

    // Add join timestamp
    await ctx.redis.zadd(monitorKey, now, `${userId}:${now}`);
    // Remove old entries
    await ctx.redis.zremrangebyscore(monitorKey, 0, now - windowMs);
    await ctx.redis.expire(monitorKey, config.joinWindowSeconds + 60);

    // Count joins in window
    const joinCount = await ctx.redis.zcard(monitorKey);

    if (joinCount >= config.joinThreshold) {
      const activeKey = `raid_active:${guildId}`;
      const alreadyActive = await ctx.redis.exists(activeKey);

      if (!alreadyActive) {
        const ttl = config.autoResolveMinutes * 60;
        await ctx.redis.set(activeKey, '1', 'EX', ttl);

        if (config.action === 'lock_channels') {
          await ctx.redis.set(`raid_lockdown:${guildId}`, '1', 'EX', ttl);
        }

        await emitRoomWithIntent(
          ctx.io,
          `guild:${guildId}`,
          GatewayIntents.GUILDS,
          'RAID_DETECTED',
          {
            guildId,
            joinCount,
            windowSeconds: config.joinWindowSeconds,
            action: config.action,
          },
        );

        logger.warn(
          { guildId, joinCount, action: config.action },
          'Raid detected',
        );
      }
    }
  }

  async function isRaidLockdown(guildId: string): Promise<boolean> {
    const exists = await ctx.redis.exists(`raid_lockdown:${guildId}`);
    return exists === 1;
  }

  async function resolveRaid(guildId: string) {
    await ctx.redis.del(`raid_active:${guildId}`);
    await ctx.redis.del(`raid_lockdown:${guildId}`);
    await ctx.redis.del(`raid_monitor:${guildId}`);

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'RAID_RESOLVED',
      { guildId },
    );
    logger.info({ guildId }, 'Raid manually resolved');
  }

  // ── Reports ─────────────────────────────────────────────────────────────

  async function createReport(guildId: string, reporterId: string, input: CreateReportInput) {
    const id = generateId();

    const [report] = await ctx.db
      .insert(reports)
      .values({
        id,
        reporterId,
        reportedUserId: input.reportedUserId,
        guildId,
        messageId: input.messageId ?? null,
        reason: input.reason,
        description: input.description ?? null,
      })
      .returning();

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'REPORT_CREATE',
      { guildId, reportId: id },
    );

    return report;
  }

  async function getReports(
    guildId: string,
    options: { status?: string; limit: number; before?: string },
  ) {
    const conditions = [eq(reports.guildId, guildId)];

    if (options.status) {
      conditions.push(eq(reports.status, options.status as any));
    }
    if (options.before) {
      conditions.push(lt(reports.id, options.before));
    }

    return ctx.db
      .select()
      .from(reports)
      .where(and(...conditions))
      .orderBy(desc(reports.createdAt))
      .limit(options.limit);
  }

  async function getReport(reportId: string) {
    const [report] = await ctx.db
      .select()
      .from(reports)
      .where(eq(reports.id, reportId));
    return report ?? null;
  }

  async function updateReport(reportId: string, reviewerId: string, input: UpdateReportInput) {
    const updates: Record<string, unknown> = {
      status: input.status,
      reviewerId,
    };

    if (input.resolutionNote !== undefined) updates.resolutionNote = input.resolutionNote;
    if (input.status === 'resolved' || input.status === 'dismissed') {
      updates.resolvedAt = new Date();
    }

    const [updated] = await ctx.db
      .update(reports)
      .set(updates)
      .where(eq(reports.id, reportId))
      .returning();

    if (updated) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${updated.guildId}`,
        GatewayIntents.GUILDS,
        'REPORT_UPDATE',
        {
          guildId: updated.guildId,
          reportId,
          status: input.status,
        },
      );
    }

    return updated ?? null;
  }

  // ── Dashboard ───────────────────────────────────────────────────────────

  async function getDashboardStats(guildId: string, days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [pendingReports] = await ctx.db
      .select({ count: count() })
      .from(reports)
      .where(and(eq(reports.guildId, guildId), eq(reports.status, 'pending')));

    const [activeRules] = await ctx.db
      .select({ count: count() })
      .from(autoModRules)
      .where(and(eq(autoModRules.guildId, guildId), eq(autoModRules.enabled, true)));

    const [recentAutoModActions] = await ctx.db
      .select({ count: count() })
      .from(autoModActionLogs)
      .where(
        and(eq(autoModActionLogs.guildId, guildId), gte(autoModActionLogs.createdAt, since)),
      );

    const [recentBans] = await ctx.db
      .select({ count: count() })
      .from(bans)
      .where(and(eq(bans.guildId, guildId), gte(bans.createdAt, since)));

    const raidActive = await ctx.redis.exists(`raid_active:${guildId}`);

    return {
      pendingReports: pendingReports?.count ?? 0,
      activeAutoModRules: activeRules?.count ?? 0,
      recentAutoModActions: recentAutoModActions?.count ?? 0,
      recentBans: recentBans?.count ?? 0,
      raidStatus: raidActive ? ('active' as const) : ('inactive' as const),
    };
  }

  async function getRecentModActions(guildId: string, limit: number) {
    // Fetch recent audit log entries (bans, kicks, timeouts)
    const auditLogs = await ctx.db
      .select()
      .from(auditLogEntries)
      .where(eq(auditLogEntries.guildId, guildId))
      .orderBy(desc(auditLogEntries.createdAt))
      .limit(limit);

    // Fetch recent automod actions
    const autoModLogs = await ctx.db
      .select()
      .from(autoModActionLogs)
      .where(eq(autoModActionLogs.guildId, guildId))
      .orderBy(desc(autoModActionLogs.createdAt))
      .limit(limit);

    // Merge and sort by createdAt desc
    const merged = [
      ...auditLogs.map((l) => ({ ...l, source: 'audit_log' as const })),
      ...autoModLogs.map((l) => ({ ...l, source: 'auto_mod' as const })),
    ].sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return tb - ta;
    });

    return merged.slice(0, limit);
  }

  return {
    getRaidConfig,
    updateRaidConfig,
    checkMemberJoin,
    isRaidLockdown,
    resolveRaid,
    createReport,
    getReports,
    getReport,
    updateReport,
    getDashboardStats,
    getRecentModActions,
  };
}

export type ModerationService = ReturnType<typeof createModerationService>;
