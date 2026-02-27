import { describe, expect, it } from 'vitest';
import express from 'express';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { filesRouter } from './files.router.js';
import type { AppContext } from '../../lib/context.js';

function createBaseContext(overrides: Partial<AppContext> = {}): AppContext {
  const ctx: Partial<AppContext> = {
    db: {} as AppContext['db'],
    io: {} as AppContext['io'],
    livekit: {} as AppContext['livekit'],
    env: {
      PORT: 4000,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://example.com/db',
      REDIS_URL: 'redis://localhost:6379',
      MINIO_ENDPOINT: 'localhost',
      MINIO_PORT: 9000,
      MINIO_ACCESS_KEY: 'x',
      MINIO_SECRET_KEY: 'y',
      MINIO_USE_SSL: false,
      JWT_SECRET: '12345678901234567890123456789012',
      JWT_ACCESS_TOKEN_EXPIRY: '15m',
      JWT_REFRESH_TOKEN_EXPIRY: '7d',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_CALLBACK_URL: 'http://localhost/callback',
      CORS_ORIGIN: 'http://localhost:5173',
      COMMUNITY_SHOP_MODERATOR_IDS: '',
      ECONOMY_AUDITOR_IDS: '',
      CDN_BASE_URL: 'http://localhost:9000',
      LIVEKIT_API_KEY: 'k',
      LIVEKIT_API_SECRET: 's',
      LIVEKIT_URL: 'ws://localhost:7880',
      LIVEKIT_HTTP_URL: 'http://localhost:7880',
      TURN_URL: 'turn:localhost:3478',
      TURN_USERNAME: 'turn',
      TURN_PASSWORD: 'turn',
    },
    redis: {
      get: async () => null,
      set: async () => 'OK',
      del: async () => 1,
    } as unknown as AppContext['redis'],
    minio: {
      statObject: async () => ({ metaData: { 'content-type': 'text/plain' } }),
      getObject: async () => Readable.from(['hello']),
      listObjectsV2: () => {
        const emitter = new Readable({ read() {} });
        setImmediate(() => {
          emitter.emit('end');
        });
        return emitter as any;
      },
    } as unknown as AppContext['minio'],
  };
  return { ...(ctx as AppContext), ...overrides };
}

async function withServer<T>(ctx: AppContext, cb: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use('/api/v1', filesRouter(ctx));
  const server = app.listen(0);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await cb(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('files router contracts', () => {
  it('requires auth when fetching non-hash file id', async () => {
    const ctx = createBaseContext();
    await withServer(ctx, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/files/12345`);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.code).toBe('UNAUTHORIZED');
    });
  });

  it('streams hash assets with safety headers', async () => {
    const ctx = createBaseContext({
      redis: {
        get: async () => JSON.stringify({ bucket: 'uploads', key: 'general/sample.txt' }),
        set: async () => 'OK',
        del: async () => 1,
      } as unknown as AppContext['redis'],
    });

    await withServer(ctx, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/files/sample.txt`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('cache-control')).toContain('immutable');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-disposition')).toContain('inline; filename=');
      expect(await res.text()).toBe('hello');
    });
  });
});

