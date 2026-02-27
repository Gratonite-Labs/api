import express from 'express';
import { performance } from 'node:perf_hooks';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import { createDb } from '@gratonite/db';
import { securityHeaders } from './middleware/security-headers.js';
import { globalRateLimiter } from './middleware/rate-limiter.js';
import { authRouter } from './modules/auth/auth.router.js';
import { usersRouter } from './modules/users/users.router.js';
import { guildsRouter } from './modules/guilds/guilds.router.js';
import { channelsRouter } from './modules/channels/channels.router.js';
import { messagesRouter } from './modules/messages/messages.router.js';
import { invitesRouter } from './modules/invites/invites.router.js';
import { relationshipsRouter } from './modules/relationships/relationships.router.js';
import { voiceRouter } from './modules/voice/voice.router.js';
import { filesRouter } from './modules/files/files.router.js';
import { threadsRouter } from './modules/threads/threads.router.js';
import { searchRouter } from './modules/search/search.router.js';
import { wikiRouter } from './modules/wiki/wiki.router.js';
import { qaRouter } from './modules/qa/qa.router.js';
import { eventsRouter } from './modules/events/events.router.js';
import { autoModRouter } from './modules/automod/automod.router.js';
import { moderationRouter } from './modules/moderation/moderation.router.js';
import { analyticsRouter } from './modules/analytics/analytics.router.js';
import { themesRouter } from './modules/themes/themes.router.js';
import { brandRouter } from './modules/brand/brand.router.js';
import { profilesRouter } from './modules/profiles/profiles.router.js';
import { botsRouter } from './modules/bots/bots.router.js';
import { communityShopRouter } from './modules/community-shop/community-shop.router.js';
import { economyRouter } from './modules/economy/economy.router.js';
import { gratonitesRouter } from './modules/gratonites/gratonites.router.js';
import { shopRouter } from './modules/shop/shop.router.js';
import { adminRouter } from './modules/admin/admin.router.js';
import { createThemesService } from './modules/themes/themes.service.js';
import { createThreadsService } from './modules/threads/threads.service.js';
import { createMessagesService } from './modules/messages/messages.service.js';
import { createEventsService } from './modules/events/events.service.js';
import { createAnalyticsService } from './modules/analytics/analytics.service.js';
import { setupGateway } from './modules/gateway/gateway.js';
import { RoomServiceClient } from 'livekit-server-sdk';
import { minioClient, ensureBuckets } from './lib/minio.js';
import { runWithRequestMetrics, getRequestCacheSummary } from './lib/request-metrics.js';
import { isOriginAllowed, parseAllowedOrigins } from './lib/cors-origins.js';
import { createLatencyAlerts } from './lib/latency-alerts.js';
import { bugReportsRouter } from './modules/bug-reports/bug-reports.router.js';
import { leaderboardRouter } from './modules/leaderboard/leaderboard.router.js';
import { pollsRouter } from './modules/polls/polls.router.js';
import { scheduledMessagesRouter } from './modules/scheduled-messages/scheduled-messages.router.js';
import { cosmeticsRouter } from './modules/cosmetics/cosmetics.router.js';
import { dailyLoginMiddleware } from './middleware/daily-login.js';

// ============================================================================
// Server bootstrap
// ============================================================================

async function main() {
  logger.info({ env: env.NODE_ENV }, 'Starting Gratonite API server');

  // ── Database connection ────────────────────────────────────────────────
  const { db } = createDb(env.DATABASE_URL);
  logger.info('Database connected');

  // ── Redis connection ───────────────────────────────────────────────────
  await redis.connect();

  // ── MinIO object storage ─────────────────────────────────────────────
  await ensureBuckets();
  logger.info('MinIO connected');

  // ── Express app ────────────────────────────────────────────────────────
  const app = express();
  const httpServer = createServer(app);
  const corsOrigins = env.CORS_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean);
  const parsedCorsOrigins = parseAllowedOrigins(env.CORS_ORIGIN);
  const latencyAlerts = createLatencyAlerts({
    routes: [
      {
        id: 'message_send',
        method: 'POST',
        pathPattern: /^\/api\/v1\/channels\/[^/]+\/messages$/,
        p95ThresholdMs: 500,
        minSamples: 20,
      },
      {
        id: 'message_list',
        method: 'GET',
        pathPattern: /^\/api\/v1\/channels\/[^/]+\/messages$/,
        p95ThresholdMs: 400,
        minSamples: 20,
      },
      {
        id: 'upload',
        method: 'POST',
        pathPattern: /^\/api\/v1\/files\/upload$/,
        p95ThresholdMs: 2000,
        minSamples: 10,
      },
      {
        id: 'file_fetch',
        method: 'GET',
        pathPattern: /^\/api\/v1\/files\/.+$/,
        p95ThresholdMs: 700,
        minSamples: 20,
      },
    ],
    onAlert: (payload) => {
      logger.error(payload, 'Latency threshold alert');
    },
  });

  // Middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isOriginAllowed(origin, env.NODE_ENV, parsedCorsOrigins)) return callback(null, true);
        logger.warn({ origin, allowedOrigins: corsOrigins }, 'CORS origin rejected');
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    }),
  );
  app.use(securityHeaders);
  app.use(globalRateLimiter);

  app.use((req, res, next) => {
    runWithRequestMetrics(() => {
      const start = performance.now();
      res.on('finish', () => {
        const duration = performance.now() - start;
        latencyAlerts.observe({
          method: req.method,
          path: req.path,
          durationMs: duration,
          statusCode: res.statusCode,
        });
        if (duration >= 200) {
          logger.warn({
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs: Math.round(duration),
            cacheSummary: getRequestCacheSummary(),
          }, 'Slow request');
        }
      });
      next();
    });
  });

  // Trust proxy (for rate limiting behind Nginx/LB)
  app.set('trust proxy', 1);

  // ── Socket.IO ──────────────────────────────────────────────────────────
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin, env.NODE_ENV, parsedCorsOrigins)) return callback(null, true);
        logger.warn({ origin, allowedOrigins: corsOrigins }, 'Socket.IO CORS origin rejected');
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 10000,
  });

  // ── LiveKit client ────────────────────────────────────────────────────
  const livekitClient = new RoomServiceClient(
    env.LIVEKIT_HTTP_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
  );

  // ── Shared context for route handlers ──────────────────────────────────
  const ctx = { db, redis, io, env, livekit: livekitClient, minio: minioClient };

  // ── Health check ───────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'gratonite-api',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // ── API routes ─────────────────────────────────────────────────────────
  app.use('/api/v1/auth', authRouter(ctx));
  
  // Apply daily login middleware to protected routes
  app.use('/api/v1', dailyLoginMiddleware(ctx));
  
  app.use('/api/v1/users', usersRouter(ctx));
  app.use('/api/v1/guilds', guildsRouter(ctx));
  app.use('/api/v1', channelsRouter(ctx));   // handles /guilds/:id/channels and /channels/:id
  app.use('/api/v1', messagesRouter(ctx));   // handles /channels/:id/messages
  app.use('/api/v1/invites', invitesRouter(ctx));
  app.use('/api/v1/relationships', relationshipsRouter(ctx));
  app.use('/api/v1', voiceRouter(ctx));
  app.use('/api/v1', filesRouter(ctx));
  app.use('/api/v1', threadsRouter(ctx));
  app.use('/api/v1', botsRouter(ctx));
  app.use('/api/v1', searchRouter(ctx));
  app.use('/api/v1', wikiRouter(ctx));
  app.use('/api/v1', qaRouter(ctx));
  app.use('/api/v1', eventsRouter(ctx));
  app.use('/api/v1', autoModRouter(ctx));
  app.use('/api/v1', moderationRouter(ctx));
  app.use('/api/v1', analyticsRouter(ctx));
  app.use('/api/v1', themesRouter(ctx));
  app.use('/api/v1', communityShopRouter(ctx));
  app.use('/api/v1', economyRouter(ctx));
  app.use('/api/v1', gratonitesRouter(ctx));
  app.use('/api/v1', shopRouter(ctx));
  app.use('/api/v1', adminRouter(ctx));
  app.use('/api/v1', brandRouter(ctx));
  app.use('/api/v1', profilesRouter(ctx));
  app.use('/api/v1', bugReportsRouter(ctx));
  app.use('/api/v1', leaderboardRouter(ctx));
  app.use('/api/v1', pollsRouter(ctx));
  app.use('/api/v1', scheduledMessagesRouter(ctx));
  app.use('/api/v1', cosmeticsRouter(ctx));

  // ── 404 handler ────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({
      code: 'NOT_FOUND',
      message: 'The requested resource was not found',
    });
  });

  // ── Error handler ──────────────────────────────────────────────────────
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error({ err }, 'Unhandled error');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message:
          env.NODE_ENV === 'production'
            ? 'An unexpected error occurred'
            : err.message,
      });
    },
  );

  // ── Seed built-in themes ─────────────────────────────────────────────
  const themesService = createThemesService(ctx);
  try {
    await themesService.seedBuiltInThemes();
    logger.info('Built-in themes seeded');
  } catch (err) {
    logger.warn({ err }, 'Skipping built-in theme seed on startup');
  }

  // ── Thread auto-archive ──────────────────────────────────────────────
  const threadsService = createThreadsService(ctx);
  setInterval(() => {
    threadsService.archiveStaleThreads().catch((err) => {
      logger.warn({ err }, 'Failed to auto-archive threads');
    });
  }, 5 * 60 * 1000);

  // ── Scheduled messages processor ─────────────────────────────────────
  const messagesService = createMessagesService(ctx);
  setInterval(() => {
    messagesService.processScheduledMessages().catch((err) => {
      logger.warn({ err }, 'Failed to process scheduled messages');
    });
  }, 30 * 1000);

  // ── Event auto-start (every 60s) ────────────────────────────────────
  const eventsService = createEventsService(ctx);
  setInterval(() => {
    eventsService.autoStartEvents().catch((err) => {
      logger.warn({ err }, 'Failed to auto-start scheduled events');
    });
  }, 60 * 1000);

  // ── Analytics flush (every 5 min) ──────────────────────────────────
  const analyticsService = createAnalyticsService(ctx);
  setInterval(() => {
    analyticsService.flushAnalytics().catch((err) => {
      logger.warn({ err }, 'Failed to flush analytics');
    });
  }, 5 * 60 * 1000);

  // ── Hourly analytics cleanup (daily) ──────────────────────────────
  setInterval(() => {
    analyticsService.cleanupOldHourlyData().catch((err) => {
      logger.warn({ err }, 'Failed to cleanup old hourly analytics');
    });
  }, 24 * 60 * 60 * 1000);

  // ── Socket.IO gateway (auth, presence, real-time events) ─────────────
  setupGateway(ctx);

  // ── Start server ───────────────────────────────────────────────────────
  httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, `🟣 Gratonite API listening on port ${env.PORT}`);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully');
    httpServer.close();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
