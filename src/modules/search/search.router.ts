import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { searchRateLimiter } from '../../middleware/rate-limiter.js';
import { createSearchService } from './search.service.js';
import { searchMessagesSchema } from './search.schemas.js';
import { createGuildsService } from '../guilds/guilds.service.js';

export function searchRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const searchService = createSearchService(ctx);
  const guildsService = createGuildsService(ctx);

  // ── GET /search/messages — Full-text search across messages ────────────
  router.get('/search/messages', auth, searchRateLimiter, async (req, res) => {
    const parsed = searchMessagesSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    // If guildId specified, verify membership
    if (parsed.data.guildId) {
      const isMember = await guildsService.isMember(parsed.data.guildId, req.user!.userId);
      if (!isMember) {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Not a member of this guild' });
      }
    }

    const results = await searchService.searchMessages(req.user!.userId, parsed.data);
    res.json(results);
  });

  return router;
}
