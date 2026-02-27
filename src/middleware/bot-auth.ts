import type { Request, Response, NextFunction } from 'express';
import type { AppContext } from '../lib/context.js';
import { createBotsService } from '../modules/bots/bots.service.js';

export interface AuthenticatedBot {
  applicationId: string;
  userId: string;
  tokenType: string;
}

declare global {
  namespace Express {
    interface Request {
      bot?: AuthenticatedBot;
    }
  }
}

export function requireBotAuth(ctx: AppContext) {
  const botsService = createBotsService(ctx);

  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bot ')) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Bot authentication required. Provide a valid Bot token.',
      });
      return;
    }

    const token = authHeader.slice(4);
    const row = await botsService.verifyBotToken(token);
    if (!row) {
      res.status(401).json({
        code: 'INVALID_BOT_TOKEN',
        message: 'Bot token is invalid or expired.',
      });
      return;
    }

    req.bot = {
      applicationId: row.applicationId,
      userId: row.userId ?? '0',
      tokenType: row.tokenType,
    };

    next();
  };
}
