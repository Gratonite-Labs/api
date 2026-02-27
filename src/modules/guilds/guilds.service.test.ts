import { describe, expect, it, vi } from 'vitest';
import { createGuildsService } from './guilds.service.js';

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    db: {},
    redis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      scan: vi.fn().mockResolvedValue(['0', []]),
    },
    ...overrides,
  } as any;
}

describe('guilds.service cache behavior', () => {
  it('uses cache for getGuild when present', async () => {
    const cachedGuild = { id: 'g1', name: 'Guild' };
    const ctx = makeCtx({
      db: { select: vi.fn() },
      redis: {
        get: vi.fn().mockResolvedValue(JSON.stringify(cachedGuild)),
        set: vi.fn(),
        del: vi.fn(),
        scan: vi.fn(),
      },
    });

    const service = createGuildsService(ctx);
    const result = await service.getGuild('g1');

    expect(result).toEqual(cachedGuild);
    expect(ctx.db.select).not.toHaveBeenCalled();
  });

  it('writes cache for getUserGuilds on cache miss', async () => {
    const memberships = [{ guildId: 'g1' }];
    const guildRows = [{ id: 'g1', name: 'Guild 1' }];

    const whereMemberships = vi.fn().mockResolvedValue(memberships);
    const fromMemberships = vi.fn().mockReturnValue({ where: whereMemberships });
    const selectMemberships = vi.fn().mockReturnValue({ from: fromMemberships });

    const whereGuilds = vi.fn().mockResolvedValue(guildRows);
    const fromGuilds = vi.fn().mockReturnValue({ where: whereGuilds });
    const selectGuilds = vi.fn().mockReturnValue({ from: fromGuilds });

    const select = vi
      .fn()
      .mockImplementationOnce(selectMemberships)
      .mockImplementationOnce(selectGuilds);

    const ctx = makeCtx({
      db: { select },
      redis: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn(),
        scan: vi.fn(),
      },
    });

    const service = createGuildsService(ctx);
    const result = await service.getUserGuilds('u1');

    expect(result).toEqual(guildRows);
    expect(ctx.redis.set).toHaveBeenCalledWith(
      'user:u1:guilds',
      JSON.stringify(guildRows),
      'EX',
      20,
    );
  });

  it('invalidates guild/member/user caches on addMember', async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values: insertValues });

    const whereUpdate = vi.fn().mockResolvedValue(undefined);
    const setUpdate = vi.fn().mockReturnValue({ where: whereUpdate });
    const update = vi.fn().mockReturnValue({ set: setUpdate });

    const del = vi.fn().mockResolvedValue(1);
    const scan = vi.fn().mockResolvedValue(['0', ['guild:g1:members:100:start']]);

    const ctx = makeCtx({
      db: { insert, update },
      redis: {
        get: vi.fn(),
        set: vi.fn(),
        del,
        scan,
      },
    });

    const service = createGuildsService(ctx);
    await service.addMember('g1', 'u1');

    expect(del).toHaveBeenCalledWith('guild:g1:meta');
    expect(del).toHaveBeenCalledWith('guild:g1:members:100:start');
    expect(del).toHaveBeenCalledWith('user:u1:guilds');
  });
});
