import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createEconomyService } from './economy.service.js';
import { claimRewardSchema, getLedgerSchema, spendCurrencySchema } from './economy.schemas.js';

export function economyRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const service = createEconomyService(ctx);
  const auditors = new Set(
    ctx.env.ECONOMY_AUDITOR_IDS.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );

  router.get('/economy/wallet', auth, async (req, res) => {
    const wallet = await service.getWallet(req.user!.userId);
    return res.json(wallet);
  });

  router.get('/economy/ledger', auth, async (req, res) => {
    const parsed = getLedgerSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    const entries = await service.getLedger(req.user!.userId, parsed.data.limit);
    return res.json(entries);
  });

  router.post('/economy/rewards/claim', auth, async (req, res) => {
    const parsed = claimRewardSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    try {
      const result = await service.claimReward(req.user!.userId, parsed.data);
      return res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error && err.name === 'RATE_LIMITED') {
        return res.status(429).json({ code: 'RATE_LIMITED' });
      }
      if (err instanceof Error && err.name === 'DAILY_CAP_REACHED') {
        return res.status(429).json({ code: 'DAILY_CAP_REACHED' });
      }
      if (err instanceof Error && err.name === 'MISSING_CONTEXT') {
        return res.status(400).json({ code: 'MISSING_CONTEXT' });
      }
      if (err instanceof Error && err.name === 'DUPLICATE_CONTEXT') {
        return res.status(409).json({ code: 'DUPLICATE_CONTEXT' });
      }
      throw err;
    }
  });

  router.post('/economy/spend', auth, async (req, res) => {
    const parsed = spendCurrencySchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    try {
      const result = await service.spendCurrency(req.user!.userId, parsed.data);
      return res.status(201).json(result);
    } catch (err) {
      if (err instanceof Error && err.name === 'INSUFFICIENT_FUNDS') {
        return res.status(409).json({ code: 'INSUFFICIENT_FUNDS' });
      }
      if (err instanceof Error && err.name === 'DUPLICATE_CONTEXT') {
        return res.status(409).json({ code: 'DUPLICATE_CONTEXT' });
      }
      throw err;
    }
  });

  router.get('/economy/audit/users/:userId/ledger', auth, async (req, res) => {
    if (!auditors.has(req.user!.userId)) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }
    const parsed = getLedgerSchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }
    const entries = await service.getLedgerForUser(req.params.userId, parsed.data.limit);
    return res.json(entries);
  });

  return router;
}
