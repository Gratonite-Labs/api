import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createGratonitesService } from './gratonites.service.js';

export function gratonitesRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const service = createGratonitesService(ctx);

  // Get user's Gratonites balance
  router.get('/gratonites/balance', auth, async (req, res) => {
    const balance = await service.getBalance(req.user!.userId);
    return res.json(balance);
  });

  // Get user's streak info
  router.get('/gratonites/streak', auth, async (req, res) => {
    const streak = await service.getStreak(req.user!.userId);
    return res.json(streak);
  });

  // Get transaction history
  router.get('/gratonites/transactions', auth, async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const transactions = await service.getTransactions(req.user!.userId, limit);
    return res.json(transactions);
  });

  // Process daily login (called by middleware or client)
  router.post('/gratonites/daily-login', auth, async (req, res) => {
    const result = await service.processDailyLogin(req.user!.userId);
    return res.json(result);
  });

  return router;
}
