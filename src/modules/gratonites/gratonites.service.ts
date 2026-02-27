import { eq, and, desc, sql } from 'drizzle-orm';
import { userStreaks, gratonitesBalances, gratonitesTransactions } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';

// Reward amounts for different activities
const REWARD_AMOUNTS = {
  daily_login: 10,
  streak_bonus_3: 5,   // 3-day streak
  streak_bonus_7: 15,  // 7-day streak
  streak_bonus_30: 50, // 30-day streak
  message_milestone_100: 20,
  message_milestone_500: 100,
  message_milestone_1000: 250,
};

export function createGratonitesService(ctx: AppContext) {
  // Ensure user has a streak record
  async function ensureStreak(userId: string) {
    await ctx.db
      .insert(userStreaks)
      .values({
        userId,
        currentStreak: 0,
        longestStreak: 0,
        totalLogins: 0,
      })
      .onConflictDoNothing();
  }

  // Ensure user has a balance record
  async function ensureBalance(userId: string) {
    await ctx.db
      .insert(gratonitesBalances)
      .values({
        userId,
        balance: 0,
        lifetimeEarned: 0,
        lifetimeSpent: 0,
      })
      .onConflictDoNothing();
  }

  // Get user's streak info
  async function getStreak(userId: string) {
    await ensureStreak(userId);
    const [streak] = await ctx.db
      .select()
      .from(userStreaks)
      .where(eq(userStreaks.userId, userId))
      .limit(1);
    return streak;
  }

  // Get user's balance
  async function getBalance(userId: string) {
    await ensureBalance(userId);
    const [balance] = await ctx.db
      .select()
      .from(gratonitesBalances)
      .where(eq(gratonitesBalances.userId, userId))
      .limit(1);
    return balance;
  }

  // Award gratonites to user
  async function awardGratonites(
    userId: string, 
    amount: number, 
    source: string, 
    description?: string
  ) {
    await ensureBalance(userId);
    
    const transactionId = generateId();
    
    // Create transaction record
    await ctx.db.insert(gratonitesTransactions).values({
      id: transactionId,
      userId,
      amount,
      type: 'earn',
      source,
      description: description || source,
    });

    // Update balance
    await ctx.db
      .update(gratonitesBalances)
      .set({
        balance: sql`${gratonitesBalances.balance} + ${amount}`,
        lifetimeEarned: sql`${gratonitesBalances.lifetimeEarned} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(gratonitesBalances.userId, userId));

    return { transactionId, amount };
  }

  // Process daily login
  async function processDailyLogin(userId: string) {
    const streak = await getStreak(userId);
    const now = new Date();
    
    // Check if already logged in today
    if (streak.lastLoginAt) {
      const lastLogin = new Date(streak.lastLoginAt);
      const hoursSinceLastLogin = (now.getTime() - lastLogin.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceLastLogin < 20) {
        return { 
          awarded: 0, 
          streak: streak.currentStreak,
          reason: 'already_logged_in_today'
        };
      }
      
      // Check if streak continues (within 48 hours)
      const hoursSinceLastStreak = (now.getTime() - lastLogin.getTime()) / (1000 * 60 * 60);
      const isStreakContinued = hoursSinceLastStreak <= 48;
      
      const newStreak = isStreakContinued ? streak.currentStreak + 1 : 1;
      const newLongestStreak = Math.max(streak.longestStreak, newStreak);
      
      // Update streak
      await ctx.db
        .update(userStreaks)
        .set({
          currentStreak: newStreak,
          longestStreak: newLongestStreak,
          lastLoginAt: now,
          totalLogins: streak.totalLogins + 1,
          updatedAt: now,
        })
        .where(eq(userStreaks.userId, userId));
      
      // Calculate rewards
      let totalAwarded = REWARD_AMOUNTS.daily_login;
      const bonuses: string[] = [];
      
      // Streak bonuses
      if (newStreak === 3) {
        totalAwarded += REWARD_AMOUNTS.streak_bonus_3;
        bonuses.push('3-day streak bonus');
      } else if (newStreak === 7) {
        totalAwarded += REWARD_AMOUNTS.streak_bonus_7;
        bonuses.push('7-day streak bonus');
      } else if (newStreak === 30) {
        totalAwarded += REWARD_AMOUNTS.streak_bonus_30;
        bonuses.push('30-day streak bonus');
      }
      
      // Award gratonites
      await awardGratonites(
        userId, 
        totalAwarded, 
        'daily_login',
        `Daily login reward${bonuses.length > 0 ? ` + ${bonuses.join(', ')}` : ''}`
      );
      
      return {
        awarded: totalAwarded,
        streak: newStreak,
        bonuses,
        reason: 'daily_login_reward'
      };
    } else {
      // First time login
      await ctx.db
        .update(userStreaks)
        .set({
          currentStreak: 1,
          longestStreak: 1,
          lastLoginAt: now,
          totalLogins: 1,
          updatedAt: now,
        })
        .where(eq(userStreaks.userId, userId));
      
      await awardGratonites(userId, REWARD_AMOUNTS.daily_login, 'daily_login', 'First daily login');
      
      return {
        awarded: REWARD_AMOUNTS.daily_login,
        streak: 1,
        bonuses: [],
        reason: 'first_login'
      };
    }
  }

  // Get transaction history
  async function getTransactions(userId: string, limit = 20) {
    return ctx.db
      .select()
      .from(gratonitesTransactions)
      .where(eq(gratonitesTransactions.userId, userId))
      .orderBy(desc(gratonitesTransactions.createdAt))
      .limit(limit);
  }

  // Check and award message milestones
  async function checkMessageMilestone(userId: string, messageCount: number) {
    const milestones = [
      { count: 100, reward: REWARD_AMOUNTS.message_milestone_100 },
      { count: 500, reward: REWARD_AMOUNTS.message_milestone_500 },
      { count: 1000, reward: REWARD_AMOUNTS.message_milestone_1000 },
    ];

    for (const milestone of milestones) {
      if (messageCount === milestone.count) {
        // Check if already awarded
        const [existing] = await ctx.db
          .select()
          .from(gratonitesTransactions)
          .where(
            and(
              eq(gratonitesTransactions.userId, userId),
              eq(gratonitesTransactions.source, `message_milestone_${milestone.count}`)
            )
          )
          .limit(1);

        if (!existing) {
          await awardGratonites(
            userId,
            milestone.reward,
            `message_milestone_${milestone.count}`,
            `Sent ${milestone.count} messages!`
          );
          return { awarded: milestone.reward, milestone: milestone.count };
        }
      }
    }

    return null;
  }

  return {
    getStreak,
    getBalance,
    processDailyLogin,
    getTransactions,
    checkMessageMilestone,
    awardGratonites,
  };
}
