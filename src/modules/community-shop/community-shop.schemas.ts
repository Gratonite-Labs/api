import { z } from 'zod';

export const communityItemTypeSchema = z.enum([
  'display_name_style_pack',
  'profile_widget_pack',
  'server_tag_badge',
  'avatar_decoration',
  'profile_effect',
  'nameplate',
]);

export const communityItemStatusSchema = z.enum([
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'published',
  'unpublished',
]);

export const communityRejectionCodeSchema = z.enum([
  'PROHIBITED_CONTENT',
  'COPYRIGHT_VIOLATION',
  'MALICIOUS_PAYLOAD',
  'LOW_QUALITY',
  'MISLEADING_METADATA',
  'UNSUPPORTED_FORMAT',
  'OTHER_POLICY_VIOLATION',
]);

export const createCommunityItemSchema = z.object({
  itemType: communityItemTypeSchema,
  name: z.string().min(2).max(64),
  description: z.string().max(255).optional(),
  payload: z.record(z.string().max(80), z.unknown()).default({}),
  payloadSchemaVersion: z.number().int().min(1).max(20).default(1),
  assetHash: z.string().max(64).optional(),
  tags: z.array(z.string().min(1).max(32)).max(12).default([]),
});

export const browseCommunityItemsSchema = z.object({
  itemType: communityItemTypeSchema.optional(),
  status: communityItemStatusSchema.optional(),
  search: z.string().max(64).optional(),
  mine: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const moderationDecisionSchema = z
  .object({
    action: z.enum(['approve', 'publish', 'reject', 'unpublish']),
    rejectionCode: communityRejectionCodeSchema.optional(),
    notes: z.string().max(800).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === 'reject' && !input.rejectionCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectionCode'],
        message: 'rejectionCode is required when action is reject',
      });
    }
    if (input.action !== 'reject' && input.rejectionCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectionCode'],
        message: 'rejectionCode is only allowed when action is reject',
      });
    }
  });

export const installCommunityItemSchema = z
  .object({
    scope: z.enum(['global', 'guild']).default('global'),
    scopeId: z.string().max(32).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.scope === 'guild' && !input.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'scopeId is required when scope is guild',
      });
    }
    if (input.scope === 'global' && input.scopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'scopeId is not allowed when scope is global',
      });
    }
  });

export const reportCommunityItemSchema = z.object({
  reason: z.string().min(2).max(64),
  details: z.string().max(500).optional(),
});

export type CreateCommunityItemInput = z.infer<typeof createCommunityItemSchema>;
export type BrowseCommunityItemsInput = z.infer<typeof browseCommunityItemsSchema>;
export type ModerationDecisionInput = z.infer<typeof moderationDecisionSchema>;
export type InstallCommunityItemInput = z.infer<typeof installCommunityItemSchema>;
export type ReportCommunityItemInput = z.infer<typeof reportCommunityItemSchema>;
