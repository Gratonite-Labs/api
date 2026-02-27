import { and, desc, eq } from 'drizzle-orm';
import { currencyLedger, currencyWallets, rewardEvents } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import type { ClaimRewardInput, RewardSource, SpendCurrencyInput } from './economy.schemas.js';

const REWARD_AMOUNTS: Record<RewardSource, number> = {
  chat_message: 2,
  server_engagement: 5,
  daily_checkin: 20,
};

const RATE_LIMITS_PER_MINUTE: Record<RewardSource, number> = {
  chat_message: 10,
  server_engagement: 6,
  daily_checkin: 1,
  shop_purchase: 20,
  creator_item_purchase: 20,
};

const DAILY_EARN_CAPS: Record<'chat_message' | 'server_engagement' | 'daily_checkin', number> = {
  chat_message: 400,
  server_engagement: 300,
  daily_checkin: 20,
};

const DEDUPE_WINDOW_SECONDS: Record<'chat_message' | 'server_engagement' | 'daily_checkin', number> = {
  chat_message: 60 * 30,
  server_engagement: 60 * 60,
  daily_checkin: 60 * 60 * 24,
};

function error(
  code: 'RATE_LIMITED' | 'DUPLICATE_CONTEXT' | 'DAILY_CAP_REACHED' | 'MISSING_CONTEXT' | 'INSUFFICIENT_FUNDS',
) {
  const err = new Error(code);
  err.name = code;
  throw err;
}

export function createEconomyService(ctx: AppContext) {
  async function ensureWallet(userId: string) {
    await ctx.db
      .insert(currencyWallets)
      .values({
        userId,
        balance: 0,
        lifetimeEarned: 0,
        lifetimeSpent: 0,
      })
      .onConflictDoNothing();
  }

  async function getWallet(userId: string) {
    await ensureWallet(userId);
    const [wallet] = await ctx.db
      .select()
      .from(currencyWallets)
      .where(eq(currencyWallets.userId, userId))
      .limit(1);
    return wallet ?? null;
  }

  async function getLedger(userId: string, limit = 20) {
    return ctx.db
      .select()
      .from(currencyLedger)
      .where(eq(currencyLedger.userId, userId))
      .orderBy(desc(currencyLedger.createdAt))
      .limit(limit);
  }

  async function getLedgerForUser(userId: string, limit = 20) {
    return getLedger(userId, limit);
  }

  async function claimReward(userId: string, input: ClaimRewardInput) {
    if (input.source !== 'daily_checkin' && !input.contextKey) {
      error('MISSING_CONTEXT');
    }

    const rewardKey = `economy:reward:${userId}:${input.source}`;
    const count = await ctx.redis.incr(rewardKey);
    if (count === 1) {
      await ctx.redis.expire(rewardKey, 60);
    }

    const limit = RATE_LIMITS_PER_MINUTE[input.source];
    if (count > limit) {
      error('RATE_LIMITED');
    }

    if (input.contextKey) {
      const dedupeKey = `economy:dedupe:${userId}:${input.source}:${input.contextKey}`;
      const inserted = await ctx.redis.set(
        dedupeKey,
        '1',
        'EX',
        DEDUPE_WINDOW_SECONDS[input.source],
        'NX',
      );
      if (inserted !== 'OK') {
        error('DUPLICATE_CONTEXT');
      }
    }

    const dailyKey = `economy:daily-earn:${userId}:${input.source}:${new Date().toISOString().slice(0, 10)}`;
    const dailyTotal = await ctx.redis.incrby(dailyKey, REWARD_AMOUNTS[input.source]);
    if (dailyTotal === REWARD_AMOUNTS[input.source]) {
      await ctx.redis.expire(dailyKey, 60 * 60 * 48);
    }
    if (dailyTotal > DAILY_EARN_CAPS[input.source]) {
      error('DAILY_CAP_REACHED');
    }

    await ensureWallet(userId);
    const amount = REWARD_AMOUNTS[input.source];
    const currentWallet = await getWallet(userId);
    const currentBalance = currentWallet?.balance ?? 0;
    const currentEarned = currentWallet?.lifetimeEarned ?? 0;

    const [wallet] = await ctx.db
      .update(currencyWallets)
      .set({
        balance: currentBalance + amount,
        lifetimeEarned: currentEarned + amount,
        updatedAt: new Date(),
      })
      .where(eq(currencyWallets.userId, userId))
      .returning();

    const ledgerId = generateId();
    await ctx.db.insert(currencyLedger).values({
      id: ledgerId,
      userId,
      direction: 'earn',
      amount,
      source: input.source,
      description: `Reward from ${input.source.replaceAll('_', ' ')}`,
      contextKey: input.contextKey ?? null,
    });

    await ctx.db.insert(rewardEvents).values({
      id: generateId(),
      userId,
      source: input.source,
      contextKey: input.contextKey ?? null,
      amount,
    });

    const [ledgerEntry] = await ctx.db
      .select()
      .from(currencyLedger)
      .where(and(eq(currencyLedger.id, ledgerId), eq(currencyLedger.userId, userId)))
      .limit(1);

    return {
      wallet,
      ledgerEntry: ledgerEntry ?? null,
      amount,
    };
  }

  async function spendCurrency(userId: string, input: SpendCurrencyInput) {
    await ensureWallet(userId);
    const wallet = await getWallet(userId);
    const balance = wallet?.balance ?? 0;

    if (input.amount > balance) {
      error('INSUFFICIENT_FUNDS');
    }

    const spendDedupeKey = input.contextKey
      ? `economy:spend:${userId}:${input.source}:${input.contextKey}`
      : null;
    if (spendDedupeKey) {
      const inserted = await ctx.redis.set(spendDedupeKey, '1', 'EX', 60 * 60 * 6, 'NX');
      if (inserted !== 'OK') {
        error('DUPLICATE_CONTEXT');
      }
    }

    const [updatedWallet] = await ctx.db
      .update(currencyWallets)
      .set({
        balance: balance - input.amount,
        lifetimeSpent: (wallet?.lifetimeSpent ?? 0) + input.amount,
        updatedAt: new Date(),
      })
      .where(eq(currencyWallets.userId, userId))
      .returning();

    const ledgerId = generateId();
    await ctx.db.insert(currencyLedger).values({
      id: ledgerId,
      userId,
      direction: 'spend',
      amount: input.amount,
      source: input.source,
      description: input.description,
      contextKey: input.contextKey ?? null,
    });

    const [ledgerEntry] = await ctx.db
      .select()
      .from(currencyLedger)
      .where(and(eq(currencyLedger.id, ledgerId), eq(currencyLedger.userId, userId)))
      .limit(1);

    return {
      wallet: updatedWallet ?? null,
      ledgerEntry: ledgerEntry ?? null,
    };
  }

  return {
    ensureWallet,
    getWallet,
    getLedger,
    getLedgerForUser,
    claimReward,
    spendCurrency,
  };
}
