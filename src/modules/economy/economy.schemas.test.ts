import { describe, expect, it } from 'vitest';
import { claimRewardSchema, getLedgerSchema, spendCurrencySchema } from './economy.schemas.js';

describe('economy schemas', () => {
  it('validates reward source payload', () => {
    const parsed = claimRewardSchema.safeParse({ source: 'chat_message', contextKey: 'm:123' });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid reward source payload', () => {
    const parsed = claimRewardSchema.safeParse({ source: 'unknown_source' });
    expect(parsed.success).toBe(false);
  });

  it('clamps ledger limit to max', () => {
    const parsed = getLedgerSchema.safeParse({ limit: 200 });
    expect(parsed.success).toBe(false);
  });

  it('validates spend payload', () => {
    const parsed = spendCurrencySchema.safeParse({
      source: 'shop_purchase',
      amount: 25,
      description: 'Starter item',
      contextKey: 'spend:1',
    });
    expect(parsed.success).toBe(true);
  });
});
