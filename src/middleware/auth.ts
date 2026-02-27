import type { Request, Response, NextFunction } from 'express';
import { createAuthService } from '../modules/auth/auth.service.js';
import type { AppContext } from '../lib/context.js';

/**
 * Authenticated user data attached to req.user by the auth middleware.
 */
export interface AuthenticatedUser {
  userId: string;
  username: string;
  tier: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * JWT authentication middleware.
 * Extracts and verifies the access token from the Authorization header.
 * Attaches the decoded user to req.user.
 */
export function requireAuth(ctx: AppContext) {
  const authService = createAuthService(ctx);

  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Authentication required. Provide a valid Bearer token.',
      });
      return;
    }

    const token = authHeader.slice(7); // Remove "Bearer " prefix
    const payload = await authService.verifyAccessToken(token);

    if (!payload) {
      res.status(401).json({
        code: 'TOKEN_EXPIRED',
        message: 'Access token is invalid or expired. Please refresh your token.',
      });
      return;
    }

    req.user = {
      userId: payload.userId,
      username: payload.username,
      tier: payload.tier,
    };

    next();
  };
}

/**
 * Optional auth middleware — doesn't fail if no token, but sets req.user if valid.
 */
export function optionalAuth(ctx: AppContext) {
  const authService = createAuthService(ctx);

  return async (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = await authService.verifyAccessToken(token);

      if (payload) {
        req.user = {
          userId: payload.userId,
          username: payload.username,
          tier: payload.tier,
        };
      }
    }

    next();
  };
}
