import { describe, expect, it } from 'vitest';
import {
  installCommunityItemSchema,
  moderationDecisionSchema,
} from './community-shop.schemas.js';

describe('community-shop schemas', () => {
  it('requires rejectionCode for reject moderation action', () => {
    const parsed = moderationDecisionSchema.safeParse({ action: 'reject' });
    expect(parsed.success).toBe(false);
  });

  it('disallows rejectionCode for non-reject moderation actions', () => {
    const parsed = moderationDecisionSchema.safeParse({
      action: 'approve',
      rejectionCode: 'LOW_QUALITY',
    });
    expect(parsed.success).toBe(false);
  });

  it('requires scopeId when guild scope is selected', () => {
    const parsed = installCommunityItemSchema.safeParse({ scope: 'guild' });
    expect(parsed.success).toBe(false);
  });

  it('disallows scopeId in global scope', () => {
    const parsed = installCommunityItemSchema.safeParse({
      scope: 'global',
      scopeId: '123',
    });
    expect(parsed.success).toBe(false);
  });
});
