import { eq, and, desc, lt } from 'drizzle-orm';
import { autoModRules, autoModActionLogs, guildMembers } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import type { CreateAutoModRuleInput, UpdateAutoModRuleInput } from './automod.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

// Built-in keyword presets (small lists for baseline filtering)
const PRESETS: Record<string, string[]> = {
  profanity: ['fuck', 'shit', 'damn', 'ass', 'bitch', 'bastard', 'crap', 'dick', 'piss'],
  sexual_content: ['porn', 'xxx', 'nsfw', 'hentai', 'onlyfans', 'nude', 'nudes'],
  slurs: ['nigger', 'faggot', 'retard', 'kike', 'spic', 'chink', 'tranny'],
};

interface AutoModCheckResult {
  blocked: boolean;
  rule?: { id: string; name: string };
  matchedKeyword?: string;
}

interface AutoModAction {
  type: 'block_message' | 'send_alert_message' | 'timeout';
  metadata?: { channelId?: string; customMessage?: string; durationSeconds?: number };
}

export function createAutoModService(ctx: AppContext) {
  const RULES_CACHE_TTL = 60; // seconds

  async function createRule(guildId: string, creatorId: string, input: CreateAutoModRuleInput) {
    // Limit: max 6 rules per trigger type per guild
    const existing = await ctx.db
      .select()
      .from(autoModRules)
      .where(
        and(eq(autoModRules.guildId, guildId), eq(autoModRules.triggerType, input.triggerType)),
      );

    if (existing.length >= 6) {
      return { error: 'MAX_RULES_PER_TRIGGER_TYPE' as const };
    }

    const id = generateId();
    const [rule] = await ctx.db
      .insert(autoModRules)
      .values({
        id,
        guildId,
        name: input.name,
        creatorId,
        eventType: input.eventType,
        triggerType: input.triggerType,
        triggerMetadata: input.triggerMetadata ?? {},
        actions: input.actions,
        enabled: input.enabled ?? true,
        exemptRoles: input.exemptRoles ?? [],
        exemptChannels: input.exemptChannels ?? [],
      })
      .returning();

    await invalidateRulesCache(guildId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'AUTO_MODERATION_RULE_CREATE',
      { guildId, rule } as any,
    );

    return rule;
  }

  async function updateRule(ruleId: string, guildId: string, input: UpdateAutoModRuleInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.triggerMetadata !== undefined) updates.triggerMetadata = input.triggerMetadata;
    if (input.actions !== undefined) updates.actions = input.actions;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.exemptRoles !== undefined) updates.exemptRoles = input.exemptRoles;
    if (input.exemptChannels !== undefined) updates.exemptChannels = input.exemptChannels;

    const [updated] = await ctx.db
      .update(autoModRules)
      .set(updates)
      .where(and(eq(autoModRules.id, ruleId), eq(autoModRules.guildId, guildId)))
      .returning();

    if (updated) {
      await invalidateRulesCache(guildId);
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'AUTO_MODERATION_RULE_UPDATE',
        { guildId, rule: updated } as any,
      );
    }

    return updated ?? null;
  }

  async function deleteRule(ruleId: string, guildId: string) {
    const [deleted] = await ctx.db
      .delete(autoModRules)
      .where(and(eq(autoModRules.id, ruleId), eq(autoModRules.guildId, guildId)))
      .returning();

    if (deleted) {
      await invalidateRulesCache(guildId);
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'AUTO_MODERATION_RULE_DELETE',
        { guildId, ruleId },
      );
    }

    return !!deleted;
  }

  async function getRules(guildId: string) {
    return ctx.db
      .select()
      .from(autoModRules)
      .where(eq(autoModRules.guildId, guildId))
      .orderBy(autoModRules.createdAt);
  }

  async function getRule(ruleId: string) {
    const [rule] = await ctx.db
      .select()
      .from(autoModRules)
      .where(eq(autoModRules.id, ruleId));
    return rule ?? null;
  }

  async function getCachedRules(guildId: string) {
    const cacheKey = `automod_rules:${guildId}`;
    const cached = await ctx.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as typeof autoModRules.$inferSelect[];
      } catch {
        // fall through to DB
      }
    }

    const rules = await ctx.db
      .select()
      .from(autoModRules)
      .where(and(eq(autoModRules.guildId, guildId), eq(autoModRules.enabled, true)));

    await ctx.redis.set(cacheKey, JSON.stringify(rules), 'EX', RULES_CACHE_TTL);
    return rules;
  }

  async function invalidateRulesCache(guildId: string) {
    await ctx.redis.del(`automod_rules:${guildId}`);
  }

  async function checkMessage(
    guildId: string,
    channelId: string,
    userId: string,
    roleIds: string[],
    content: string,
    mentionCount: number,
  ): Promise<AutoModCheckResult> {
    const rules = await getCachedRules(guildId);
    const messageSendRules = rules.filter((r) => r.eventType === 'message_send');

    for (const rule of messageSendRules) {
      // Check exemptions
      const exemptRoles = (rule.exemptRoles ?? []) as string[];
      const exemptChannels = (rule.exemptChannels ?? []) as string[];

      if (exemptChannels.includes(channelId)) continue;
      if (roleIds.some((id) => exemptRoles.includes(id))) continue;

      const metadata = (rule.triggerMetadata ?? {}) as Record<string, unknown>;
      let matchedKeyword: string | undefined;

      switch (rule.triggerType) {
        case 'keyword': {
          const keywords = (metadata.keywordFilter as string[]) ?? [];
          const allowList = (metadata.allowList as string[]) ?? [];
          const lower = content.toLowerCase();

          for (const kw of keywords) {
            if (lower.includes(kw.toLowerCase())) {
              // Check allow list
              if (!allowList.some((aw) => lower.includes(aw.toLowerCase()))) {
                matchedKeyword = kw;
                break;
              }
            }
          }

          // Regex patterns
          if (!matchedKeyword) {
            const patterns = (metadata.regexPatterns as string[]) ?? [];
            for (const pattern of patterns) {
              try {
                const re = new RegExp(pattern, 'i');
                const match = content.match(re);
                if (match) {
                  matchedKeyword = match[0];
                  break;
                }
              } catch {
                // Invalid regex, skip
              }
            }
          }
          break;
        }

        case 'keyword_preset': {
          const presets = (metadata.presets as string[]) ?? [];
          const lower = content.toLowerCase();
          const words = lower.split(/\s+/);

          for (const preset of presets) {
            const list = PRESETS[preset];
            if (!list) continue;
            for (const word of words) {
              if (list.includes(word)) {
                matchedKeyword = word;
                break;
              }
            }
            if (matchedKeyword) break;
          }
          break;
        }

        case 'mention_spam': {
          const limit = (metadata.mentionTotalLimit as number) ?? 5;
          if (mentionCount >= limit) {
            matchedKeyword = `${mentionCount} mentions (limit: ${limit})`;
          }
          break;
        }

        case 'spam': {
          // Simple duplicate detection: hash recent messages
          const hash = simpleHash(content);
          const spamKey = `spam:${guildId}:${userId}`;
          const now = Date.now();

          await ctx.redis.zadd(spamKey, now, `${hash}:${now}`);
          await ctx.redis.zremrangebyscore(spamKey, 0, now - 60000);
          await ctx.redis.expire(spamKey, 60);

          // Count same hash in last 60s
          const members = await ctx.redis.zrangebyscore(spamKey, now - 60000, now);
          const sameHash = members.filter((m) => m.startsWith(`${hash}:`)).length;
          if (sameHash >= 3) {
            matchedKeyword = 'duplicate message spam';
          }
          break;
        }
      }

      if (matchedKeyword) {
        // Execute actions
        const actions = (rule.actions ?? []) as AutoModAction[];
        let blocked = false;

        for (const action of actions) {
          switch (action.type) {
            case 'block_message':
              blocked = true;
              break;

            case 'send_alert_message':
              if (action.metadata?.channelId) {
                await emitRoomWithIntent(
                  ctx.io,
                  `guild:${guildId}`,
                  GatewayIntents.GUILDS,
                  'AUTO_MODERATION_ACTION_EXECUTION',
                  {
                    guildId,
                    ruleId: rule.id,
                    ruleName: rule.name,
                    userId,
                    channelId,
                    actionType: 'send_alert_message',
                    matchedKeyword,
                  },
                );
              }
              break;

            case 'timeout':
              if (action.metadata?.durationSeconds) {
                const until = new Date(
                  Date.now() + action.metadata.durationSeconds * 1000,
                );
                await ctx.db
                  .update(guildMembers)
                  .set({ communicationDisabledUntil: until })
                  .where(
                    and(
                      eq(guildMembers.userId, userId),
                      eq(guildMembers.guildId, guildId),
                    ),
                  );
              }
              break;
          }
        }

        // Log action
        await ctx.db.insert(autoModActionLogs).values({
          id: generateId(),
          guildId,
          ruleId: rule.id,
          userId,
          channelId,
          messageContent: content.slice(0, 1000),
          matchedKeyword: matchedKeyword.slice(0, 200),
          actionType: blocked ? 'block_message' : 'send_alert_message',
        });

        if (blocked) {
          return { blocked: true, rule: { id: rule.id, name: rule.name }, matchedKeyword };
        }
      }
    }

    return { blocked: false };
  }

  async function getActionLogs(
    guildId: string,
    options: { limit: number; before?: string; ruleId?: string; userId?: string },
  ) {
    const conditions = [eq(autoModActionLogs.guildId, guildId)];

    if (options.before) {
      conditions.push(lt(autoModActionLogs.id, options.before));
    }
    if (options.ruleId) {
      conditions.push(eq(autoModActionLogs.ruleId, options.ruleId));
    }
    if (options.userId) {
      conditions.push(eq(autoModActionLogs.userId, options.userId));
    }

    return ctx.db
      .select()
      .from(autoModActionLogs)
      .where(and(...conditions))
      .orderBy(desc(autoModActionLogs.createdAt))
      .limit(options.limit);
  }

  return {
    createRule,
    updateRule,
    deleteRule,
    getRules,
    getRule,
    checkMessage,
    getActionLogs,
    invalidateRulesCache,
  };
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return hash.toString(36);
}

export type AutoModService = ReturnType<typeof createAutoModService>;
