import { describe, expect, it, vi } from 'vitest';
import { createCommunityShopService } from './community-shop.service.js';

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    db: {},
    env: {
      COMMUNITY_SHOP_MODERATOR_IDS: '',
    },
    ...overrides,
  } as any;
}

describe('community-shop service policy guards', () => {
  it('rejects unsafe payloads during draft creation', async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const ctx = makeCtx({
      db: { insert },
    });

    const service = createCommunityShopService(ctx);
    await expect(
      service.createItem('u1', {
        itemType: 'nameplate',
        name: 'Unsafe Item',
        payload: { html: '<script>alert(1)</script>' },
        payloadSchemaVersion: 1,
        tags: ['unsafe'],
      }),
    ).rejects.toMatchObject({ name: 'UNSAFE_PAYLOAD' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('denies moderation queue access for non-moderators', async () => {
    const ctx = makeCtx({
      env: {
        COMMUNITY_SHOP_MODERATOR_IDS: 'mod-1,mod-2',
      },
    });
    const service = createCommunityShopService(ctx);
    await expect(service.getModerationQueue('user-1', 10)).rejects.toMatchObject({ name: 'FORBIDDEN' });
  });

  it('enforces moderation state transitions', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        id: 'item-1',
        status: 'approved',
        publishedAt: null,
      },
    ]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const ctx = makeCtx({
      env: {
        COMMUNITY_SHOP_MODERATOR_IDS: 'mod-1',
      },
      db: {
        select,
      },
    });

    const service = createCommunityShopService(ctx);
    await expect(
      service.moderateItem('item-1', 'mod-1', {
        action: 'unpublish',
        notes: 'not currently published',
      }),
    ).rejects.toMatchObject({ name: 'INVALID_TRANSITION' });
  });
});
