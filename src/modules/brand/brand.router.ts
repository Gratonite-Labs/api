import { Router } from 'express';
import { createHash } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { uploadRateLimiter } from '../../middleware/rate-limiter.js';
import { BUCKETS } from '../../lib/minio.js';
import { createBrandService } from './brand.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { updateBrandSchema, updateCssSchema } from './brand.schemas.js';

const backgroundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS.banners.maxSize },
});

export function brandRouter(ctx: AppContext): Router {
  const router = Router();
  const brandService = createBrandService(ctx);
  const guildsService = createGuildsService(ctx);
  const auth = requireAuth(ctx);

  async function checkOwner(guildId: string, userId: string) {
    const guild = await guildsService.getGuild(guildId);
    return guild?.ownerId === userId;
  }

  async function checkMember(guildId: string, userId: string) {
    return guildsService.isMember(guildId, userId);
  }

  // ── Get guild brand ────────────────────────────────────────────────────
  router.get('/guilds/:guildId/brand', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkMember(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const brand = await brandService.getBrand(guildId);
    if (!brand) {
      return res.status(404).json({ code: 'BRAND_NOT_FOUND' });
    }
    res.json(brand);
  });

  // ── Update guild brand ─────────────────────────────────────────────────
  router.patch('/guilds/:guildId/brand', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateBrandSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const brand = await brandService.updateBrand(guildId, parsed.data);
    if (!brand) {
      return res.status(404).json({ code: 'BRAND_NOT_FOUND' });
    }
    res.json(brand);
  });

  // ── Upload brand background image ──────────────────────────────────────
  router.post(
    '/guilds/:guildId/brand/background',
    auth,
    uploadRateLimiter,
    backgroundUpload.single('file'),
    async (req, res) => {
      const { guildId } = req.params;
      if (!(await checkOwner(guildId, req.user!.userId))) {
        return res.status(403).json({ code: 'FORBIDDEN' });
      }

      if (!req.file) {
        return res.status(400).json({ code: 'NO_FILE' });
      }

      // Process image: strip EXIF, resize to max 1920x1080, convert to WebP
      const processed = await sharp(req.file.buffer)
        .rotate()
        .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();

      const hash = createHash('sha256').update(processed).digest('hex').slice(0, 32);
      const key = `brand/${guildId}/${hash}.webp`;

      await ctx.minio.putObject(BUCKETS.banners.name, key, processed, processed.length, {
        'Content-Type': 'image/webp',
      });

      const brand = await brandService.updateBackgroundImage(guildId, `${hash}.webp`);
      res.json(brand);
    },
  );

  // ── Get guild custom CSS ───────────────────────────────────────────────
  router.get('/guilds/:guildId/css', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkMember(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const css = await brandService.getCustomCss(guildId);
    res.json(css || { guildId, css: '', updatedAt: null, updatedBy: null });
  });

  // ── Update guild custom CSS ────────────────────────────────────────────
  router.patch('/guilds/:guildId/css', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkOwner(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateCssSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await brandService.updateCustomCss(
      guildId,
      req.user!.userId,
      parsed.data.css,
    );
    res.json(result);
  });

  return router;
}
