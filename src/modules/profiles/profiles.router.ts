import { Router } from 'express';
import { createHash } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import type { AppContext } from '../../lib/context.js';
import { requireAuth, optionalAuth } from '../../middleware/auth.js';
import { uploadRateLimiter } from '../../middleware/rate-limiter.js';
import { BUCKETS } from '../../lib/minio.js';
import { createProfilesService } from './profiles.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { updateMemberProfileSchema, equipCustomizationSchema } from './profiles.schemas.js';

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS.avatars.maxSize },
});

const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS.banners.maxSize },
});

export function profilesRouter(ctx: AppContext): Router {
  const router = Router();
  const profilesService = createProfilesService(ctx);
  const guildsService = createGuildsService(ctx);
  const auth = requireAuth(ctx);
  const optAuth = optionalAuth(ctx);

  async function checkMember(guildId: string, userId: string) {
    return guildsService.isMember(guildId, userId);
  }

  // ── Get per-server profile ─────────────────────────────────────────────
  router.get('/guilds/:guildId/members/:userId/profile', auth, async (req, res) => {
    const { guildId, userId } = req.params;
    if (!(await checkMember(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const profile = await profilesService.getMemberProfile(userId, guildId);
    res.json(
      profile || {
        userId,
        guildId,
        nickname: null,
        avatarHash: null,
        avatarAnimated: false,
        bannerHash: null,
        bannerAnimated: false,
        bio: null,
      },
    );
  });

  // ── Update own per-server profile ──────────────────────────────────────
  router.patch('/guilds/:guildId/members/@me/profile', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkMember(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateMemberProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const profile = await profilesService.updateMemberProfile(
      req.user!.userId,
      guildId,
      parsed.data,
    );
    res.json(profile);
  });

  // ── Upload per-server avatar ───────────────────────────────────────────
  router.post(
    '/guilds/:guildId/members/@me/profile/avatar',
    auth,
    uploadRateLimiter,
    avatarUpload.single('file'),
    async (req, res) => {
      const { guildId } = req.params;
      if (!(await checkMember(guildId, req.user!.userId))) {
        return res.status(403).json({ code: 'FORBIDDEN' });
      }

      if (!req.file) {
        return res.status(400).json({ code: 'NO_FILE' });
      }

      const processed = await sharp(req.file.buffer)
        .rotate()
        .resize(1024, 1024, { fit: 'cover' })
        .webp({ quality: 85 })
        .toBuffer();

      const hash = createHash('sha256').update(processed).digest('hex').slice(0, 32);
      const key = `members/${guildId}/${req.user!.userId}/${hash}.webp`;

      await ctx.minio.putObject(BUCKETS.avatars.name, key, processed, processed.length, {
        'Content-Type': 'image/webp',
      });

      const profile = await profilesService.updateMemberAvatar(
        req.user!.userId,
        guildId,
        `${hash}.webp`,
        false,
      );
      res.json(profile);
    },
  );

  // ── Remove per-server avatar ───────────────────────────────────────────
  router.delete('/guilds/:guildId/members/@me/profile/avatar', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkMember(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const profile = await profilesService.updateMemberAvatar(
      req.user!.userId,
      guildId,
      null,
      false,
    );
    res.json(profile);
  });

  // ── Upload per-server banner ───────────────────────────────────────────
  router.post(
    '/guilds/:guildId/members/@me/profile/banner',
    auth,
    uploadRateLimiter,
    bannerUpload.single('file'),
    async (req, res) => {
      const { guildId } = req.params;
      if (!(await checkMember(guildId, req.user!.userId))) {
        return res.status(403).json({ code: 'FORBIDDEN' });
      }

      if (!req.file) {
        return res.status(400).json({ code: 'NO_FILE' });
      }

      const processed = await sharp(req.file.buffer)
        .rotate()
        .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();

      const hash = createHash('sha256').update(processed).digest('hex').slice(0, 32);
      const key = `members/${guildId}/${req.user!.userId}/${hash}.webp`;

      await ctx.minio.putObject(BUCKETS.banners.name, key, processed, processed.length, {
        'Content-Type': 'image/webp',
      });

      const profile = await profilesService.updateMemberBanner(
        req.user!.userId,
        guildId,
        `${hash}.webp`,
        false,
      );
      res.json(profile);
    },
  );

  // ── Remove per-server banner ───────────────────────────────────────────
  router.delete('/guilds/:guildId/members/@me/profile/banner', auth, async (req, res) => {
    const { guildId } = req.params;
    if (!(await checkMember(guildId, req.user!.userId))) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const profile = await profilesService.updateMemberBanner(
      req.user!.userId,
      guildId,
      null,
      false,
    );
    res.json(profile);
  });

  // ── List avatar decorations ────────────────────────────────────────────
  router.get('/avatar-decorations', optAuth, async (_req, res) => {
    const decorations = await profilesService.getAvatarDecorations();
    res.json(decorations);
  });

  // ── List profile effects ───────────────────────────────────────────────
  router.get('/profile-effects', optAuth, async (_req, res) => {
    const effects = await profilesService.getProfileEffects();
    res.json(effects);
  });

  // ── List nameplates ────────────────────────────────────────────────────
  router.get('/nameplates', optAuth, async (_req, res) => {
    const nameplates = await profilesService.getNameplates();
    res.json(nameplates);
  });

  // ── Equip decoration / effect ──────────────────────────────────────────
  router.patch('/users/@me/customization', auth, async (req, res) => {
    const parsed = equipCustomizationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await profilesService.equipCustomization(req.user!.userId, parsed.data);

    if ('error' in result) {
      if (
        result.error === 'DECORATION_NOT_FOUND' ||
        result.error === 'EFFECT_NOT_FOUND' ||
        result.error === 'NAMEPLATE_NOT_FOUND'
      ) {
        return res.status(404).json({ code: result.error });
      }
      return res.status(400).json({ code: result.error });
    }

    res.json(result.profile);
  });

  return router;
}
