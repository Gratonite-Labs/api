import { describe, expect, it, vi } from 'vitest';
import { createChannelsService } from './channels.service.js';

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    db: {},
    redis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    },
    ...overrides,
  } as any;
}

describe('channels.service cache behavior', () => {
  it('uses cache for getGuildChannels when present', async () => {
    const cached = [{ id: 'c1', guildId: 'g1', name: 'general' }];
    const ctx = makeCtx({
      db: { select: vi.fn() },
      redis: {
        get: vi.fn().mockResolvedValue(JSON.stringify(cached)),
        set: vi.fn(),
        del: vi.fn(),
      },
    });

    const service = createChannelsService(ctx);
    const result = await service.getGuildChannels('g1');

    expect(result).toEqual(cached);
    expect(ctx.db.select).not.toHaveBeenCalled();
  });

  it('queries DB and writes cache for getGuildChannels on miss', async () => {
    const rows = [{ id: 'c1', guildId: 'g1', name: 'general', position: 0 }];
    const orderBy = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });

    const ctx = makeCtx({
      db: { select },
      redis: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn(),
      },
    });

    const service = createChannelsService(ctx);
    const result = await service.getGuildChannels('g1');

    expect(result).toEqual(rows);
    expect(select).toHaveBeenCalledTimes(1);
    expect(ctx.redis.set).toHaveBeenCalledWith(
      'guild:g1:channels',
      JSON.stringify(rows),
      'EX',
      20,
    );
  });

  it('invalidates channel and guild channel cache on updateChannel', async () => {
    const updated = { id: 'c1', guildId: 'g1', name: 'renamed' };
    const returning = vi.fn().mockResolvedValue([updated]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });

    const ctx = makeCtx({
      db: { update },
      redis: {
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn().mockResolvedValue(1),
      },
    });

    const service = createChannelsService(ctx);
    await service.updateChannel('c1', { name: 'renamed' });

    expect(ctx.redis.del).toHaveBeenCalledWith('channel:c1:meta');
    expect(ctx.redis.del).toHaveBeenCalledWith('guild:g1:channels');
  });
});
