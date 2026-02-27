import { z } from 'zod';

const actionSchema = z.object({
  type: z.enum(['block_message', 'send_alert_message', 'timeout']),
  metadata: z
    .object({
      channelId: z.string().optional(),
      customMessage: z.string().max(150).optional(),
      durationSeconds: z.number().int().min(1).max(2419200).optional(),
    })
    .optional(),
});

export const createAutoModRuleSchema = z.object({
  name: z.string().min(1).max(100),
  eventType: z.enum(['message_send', 'member_update']),
  triggerType: z.enum(['keyword', 'spam', 'keyword_preset', 'mention_spam']),
  triggerMetadata: z
    .object({
      keywordFilter: z.array(z.string().max(60)).max(1000).optional(),
      regexPatterns: z.array(z.string().max(260)).max(10).optional(),
      allowList: z.array(z.string().max(60)).max(100).optional(),
      mentionTotalLimit: z.number().int().min(1).max(50).optional(),
      presets: z.array(z.enum(['profanity', 'sexual_content', 'slurs'])).optional(),
    })
    .optional()
    .default({}),
  actions: z.array(actionSchema).min(1).max(5),
  enabled: z.boolean().optional().default(true),
  exemptRoles: z.array(z.string()).max(20).optional().default([]),
  exemptChannels: z.array(z.string()).max(50).optional().default([]),
});

export const updateAutoModRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  triggerMetadata: z
    .object({
      keywordFilter: z.array(z.string().max(60)).max(1000).optional(),
      regexPatterns: z.array(z.string().max(260)).max(10).optional(),
      allowList: z.array(z.string().max(60)).max(100).optional(),
      mentionTotalLimit: z.number().int().min(1).max(50).optional(),
      presets: z.array(z.enum(['profanity', 'sexual_content', 'slurs'])).optional(),
    })
    .optional(),
  actions: z.array(actionSchema).min(1).max(5).optional(),
  enabled: z.boolean().optional(),
  exemptRoles: z.array(z.string()).max(20).optional(),
  exemptChannels: z.array(z.string()).max(50).optional(),
});

export const getAutoModLogsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
  ruleId: z.string().optional(),
  userId: z.string().optional(),
});

export type CreateAutoModRuleInput = z.infer<typeof createAutoModRuleSchema>;
export type UpdateAutoModRuleInput = z.infer<typeof updateAutoModRuleSchema>;
