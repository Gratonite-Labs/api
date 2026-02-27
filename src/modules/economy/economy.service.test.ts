import { describe, expect, it, vi } from 'vitest';
import { createEconomyService } from './economy.service.js';

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    db: {},
    redis: {
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      set: vi.fn().mockResolvedValue('OK'),
      incrby: vi.fn().mockResolvedValue(1),
    },
    ...overrides,
  } as any;
}

describe('economy service guards', () => {
  it('requires context for chat reward claims', async () => {
    const service = createEconomyService(makeCtx());
    await expect(service.claimReward('u1', { source: 'chat_message' })).rejects.toMatchObject({
      name: 'MISSING_CONTEXT',
    });
  });

  it('enforces daily cap on rewards', async () => {
    const ctx = makeCtx({
      redis: {
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
        set: vi.fn().mockResolvedValue('OK'),
        incrby: vi.fn().mockResolvedValue(401),
      },
    });
    const service = createEconomyService(ctx);
    await expect(service.claimReward('u1', { source: 'chat_message', contextKey: 'msg:1' })).rejects.toMatchObject({
      name: 'DAILY_CAP_REACHED',
    });
  });

  it('rejects spending beyond available balance', async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });

    const limit = vi.fn().mockResolvedValue([
      {
        userId: 'u1',
        balance: 5,
        lifetimeEarned: 10,
        lifetimeSpent: 5,
        updatedAt: new Date(),
      },
    ]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });

    const service = createEconomyService(
      makeCtx({
        db: { insert, select },
      }),
    );

    await expect(
      service.spendCurrency('u1', {
        source: 'shop_purchase',
        amount: 25,
        description: 'Too expensive',
      }),
    ).rejects.toMatchObject({ name: 'INSUFFICIENT_FUNDS' });
  });
});
