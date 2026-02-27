import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { users, userProfiles, gratonitesBalances } from '@gratonite/db';
import { eq, desc } from 'drizzle-orm';

const leaderboardQuerySchema = z.object({
  period: z.enum(['week', 'month', 'all']).default('week'),
});

export function leaderboardRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);

  // GET /leaderboard?period=week|month|all
  router.get('/leaderboard', auth, async (req, res) => {
    const parsed = leaderboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid leaderboard query',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    // NOTE: The `period` filter is cosmetic for now. We always return total
    // messageCount because per-message timestamps are not easily queryable
    // for time-windowed counts. A future migration could add a materialised
    // view or dedicated counter table partitioned by period.
    const _period = parsed.data.period;

    const rows = await ctx.db
      .select({
        userId: userProfiles.userId,
        username: users.username,
        displayName: userProfiles.displayName,
        avatarHash: userProfiles.avatarHash,
        messageCount: userProfiles.messageCount,
        gratonitesEarned: gratonitesBalances.lifetimeEarned,
        memberSince: users.createdAt,
      })
      .from(userProfiles)
      .innerJoin(users, eq(users.id, userProfiles.userId))
      .leftJoin(gratonitesBalances, eq(gratonitesBalances.userId, userProfiles.userId))
      .orderBy(desc(userProfiles.messageCount))
      .limit(50);

    const leaderboard = rows.map((row, index) => ({
      rank: index + 1,
      userId: row.userId,
      username: row.username,
      displayName: row.displayName,
      avatarHash: row.avatarHash,
      messageCount: row.messageCount,
      gratonitesEarned: row.gratonitesEarned ?? 0,
      memberSince: row.memberSince.toISOString(),
    }));

    return res.json(leaderboard);
  });

  return router;
}
