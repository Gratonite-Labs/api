import type { RequestHandler } from 'express';
import { redis } from '../lib/redis.js';

/**
 * Redis sliding window rate limiter.
 * Returns standard rate limit headers + 429 on exceeded.
 */
export function rateLimiter(options: {
  /** Window size in seconds */
  windowSeconds: number;
  /** Max requests per window */
  maxRequests: number;
  /** Key prefix for Redis */
  keyPrefix: string;
  /** Function to extract the rate limit key from request (default: IP address) */
  keyExtractor?: (req: Express.Request) => string;
}): RequestHandler {
  const { windowSeconds, maxRequests, keyPrefix, keyExtractor } = options;

  return async (req, res, next) => {
    const key = keyExtractor
      ? keyExtractor(req as Express.Request)
      : (req.ip ?? 'unknown');
    const redisKey = `ratelimit:${keyPrefix}:${key}`;

    try {
      const now = Date.now();
      const windowStart = now - windowSeconds * 1000;

      // Use Redis pipeline for atomicity
      const pipeline = redis.pipeline();

      // Remove expired entries
      pipeline.zremrangebyscore(redisKey, 0, windowStart);

      // Count current entries
      pipeline.zcard(redisKey);

      // Add current request
      pipeline.zadd(redisKey, now, `${now}:${Math.random()}`);

      // Set TTL to auto-cleanup
      pipeline.expire(redisKey, windowSeconds);

      const results = await pipeline.exec();
      const currentCount = (results?.[1]?.[1] as number) ?? 0;

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - currentCount - 1));
      res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowSeconds * 1000) / 1000));

      if (currentCount >= maxRequests) {
        const retryAfter = Math.ceil(windowSeconds);
        res.setHeader('Retry-After', retryAfter);
        res.status(429).json({
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please try again later.',
          retryAfter: retryAfter * 1000,
        });
        return;
      }

      next();
    } catch (err) {
      // If Redis is down, allow the request (fail open)
      next();
    }
  };
}

// ============================================================================
// Pre-configured rate limiters for common routes
// ============================================================================

/** Global rate limiter: 50 req/s per IP */
export const globalRateLimiter = rateLimiter({
  windowSeconds: 1,
  maxRequests: 50,
  keyPrefix: 'global',
});

/** Auth rate limiter: 5 attempts per minute per IP */
export const authRateLimiter = rateLimiter({
  windowSeconds: 60,
  maxRequests: 5,
  keyPrefix: 'auth',
});

/** Registration rate limiter: 20 per minute per IP (dev-friendly) */
export const registerRateLimiter = rateLimiter({
  windowSeconds: 60,
  maxRequests: 20,
  keyPrefix: 'register',
});

/** Message send rate limiter: 5 per 5 seconds per user */
export const messageRateLimiter = rateLimiter({
  windowSeconds: 5,
  maxRequests: 5,
  keyPrefix: 'message',
});

/** File upload rate limiter: 10 per minute per user */
export const uploadRateLimiter = rateLimiter({
  windowSeconds: 60,
  maxRequests: 10,
  keyPrefix: 'upload',
  keyExtractor: (req) => (req as any).user?.userId ?? req.ip ?? 'unknown',
});

/** Poll vote rate limiter: 10 per 5 seconds per user */
export const pollVoteRateLimiter = rateLimiter({
  windowSeconds: 5,
  maxRequests: 10,
  keyPrefix: 'poll_vote',
  keyExtractor: (req) => (req as any).user?.userId ?? req.ip ?? 'unknown',
});

/** Search rate limiter: 10 per 10 seconds per user */
export const searchRateLimiter = rateLimiter({
  windowSeconds: 10,
  maxRequests: 10,
  keyPrefix: 'search',
  keyExtractor: (req) => (req as any).user?.userId ?? req.ip ?? 'unknown',
});
