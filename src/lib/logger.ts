import pino from 'pino';
import { env } from '../env.js';

/**
 * Structured JSON logger via pino — fastest Node.js logger.
 * Format: {level, time, service, msg, ...context}
 */
export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  base: {
    service: 'gratonite-api',
  },
});
