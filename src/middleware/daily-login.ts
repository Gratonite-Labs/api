import type { Request, Response, NextFunction } from 'express';
import type { AppContext } from '../lib/context.js';
import { createGratonitesService } from '../modules/gratonites/gratonites.service.js';

/**
 * Middleware that processes daily login rewards for authenticated users
 * Should be applied after auth middleware
 */
export function dailyLoginMiddleware(ctx: AppContext) {
  const service = createGratonitesService(ctx);

  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip if not authenticated
    if (!req.user?.userId) {
      return next();
    }

    try {
      // Process daily login (non-blocking)
      service.processDailyLogin(req.user.userId).catch((err) => {
        // Log error but don't block the request
        console.error('Failed to process daily login:', err);
      });

      next();
    } catch (err) {
      // Continue even if login processing fails
      next();
    }
  };
}
