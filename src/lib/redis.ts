import Redis from 'ioredis';
import { env } from '../env.js';
import { logger } from './logger.js';

/**
 * Redis client for caching, pub/sub, and session management.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 3000);
    return delay;
  },
});

redis.on('connect', () => {
  logger.info('Redis connected');
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

/**
 * Separate Redis client for pub/sub subscriber
 * (subscriber connections can't be used for other commands)
 */
export const redisSub = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});
