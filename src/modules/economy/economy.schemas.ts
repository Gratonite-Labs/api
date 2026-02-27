import { z } from 'zod';

export const rewardSourceSchema = z.enum([
  'chat_message',
  'server_engagement',
  'daily_checkin',
  'shop_purchase',
  'creator_item_purchase',
]);

export const earnRewardSourceSchema = z.enum([
  'chat_message',
  'server_engagement',
  'daily_checkin',
]);

export const spendSourceSchema = z.enum([
  'shop_purchase',
  'creator_item_purchase',
]);

export const claimRewardSchema = z.object({
  source: earnRewardSourceSchema,
  contextKey: z.string().min(1).max(100).optional(),
});

export const spendCurrencySchema = z.object({
  source: spendSourceSchema,
  amount: z.coerce.number().int().min(1).max(100000),
  description: z.string().min(2).max(255),
  contextKey: z.string().min(1).max(100).optional(),
});

export const getLedgerSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ClaimRewardInput = z.infer<typeof claimRewardSchema>;
export type RewardSource = z.infer<typeof rewardSourceSchema>;
export type SpendCurrencyInput = z.infer<typeof spendCurrencySchema>;
