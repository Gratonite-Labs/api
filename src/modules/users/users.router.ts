import { Router } from 'express';
import { createHash } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { eq, ilike, or, and } from 'drizzle-orm';
import { users, userProfiles, userSettings, userCustomStatus, relationships, guildMembers, guilds } from '@gratonite/db';
import { inArray } from 'drizzle-orm';
import { createDndService } from './dnd.service.js';
import { createAdminService } from '../admin/admin.service.js';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { logger } from '../../lib/logger.js';
import { BUCKETS } from '../../lib/minio.js';
import { uploadRateLimiter } from '../../middleware/rate-limiter.js';

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS.avatars.maxSize },
});

const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS.banners.maxSize },
});

export function usersRouter(ctx: AppContext): Router {
  const router = Router();
  const auth = requireAuth(ctx);
  const adminService = createAdminService(ctx);
  const allowedPresenceStatuses = new Set(['online', 'idle', 'dnd', 'invisible']);

  // ── GET /api/v1/users (batch summary) ─────────────────────────────────
  // ids=comma-separated list of user IDs
  router.get('/', auth, async (req, res) => {
    try {
      const idsParam = String(req.query['ids'] ?? '').trim();
      if (!idsParam) {
        res.json([]);
        return;
      }
      const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean);
      if (ids.length === 0) {
        res.json([]);
        return;
      }
      if (ids.length > 100) {
        res.status(400).json({ code: 'TOO_MANY_IDS', message: 'Max 100 ids per request' });
        return;
      }

      const bigintIds = ids.map((id) => BigInt(id));
      const rows = await ctx.db
        .select({
          id: users.id,
          username: users.username,
          displayName: userProfiles.displayName,
          avatarHash: userProfiles.avatarHash,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(inArray(users.id, bigintIds));

      res.json(rows.map((row) => ({
        id: row.id.toString(),
        username: row.username,
        displayName: row.displayName,
        avatarHash: row.avatarHash,
      })));
    } catch (err) {
      logger.error({ err }, 'Error fetching user summaries');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── GET /api/v1/users/search ─────────────────────────────────────────
  // Search users by username or display name
  router.get('/search', auth, async (req, res) => {
    try {
      const query = String(req.query['q'] ?? '').trim();
      if (!query || query.length < 2) {
        return res.json([]);
      }

      const pattern = `%${query}%`;
      const rows = await ctx.db
        .select({
          id: users.id,
          username: users.username,
          displayName: userProfiles.displayName,
          avatarHash: userProfiles.avatarHash,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(or(
          ilike(users.username, pattern),
          ilike(userProfiles.displayName, pattern),
        ))
        .limit(10);

      res.json(rows.map((row) => ({
        id: row.id.toString(),
        username: row.username,
        displayName: row.displayName,
        avatarHash: row.avatarHash,
      })));
    } catch (err) {
      logger.error({ err }, 'Error searching users');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── GET /api/v1/users/@me ──────────────────────────────────────────────
  // Returns the current authenticated user's profile
  router.get('/@me', requireAuth(ctx), async (req, res) => {
    try {
      const userId = BigInt(req.user!.userId);

      const [user] = await ctx.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!user) {
        res.status(404).json({
          code: 'USER_NOT_FOUND',
          message: 'User not found',
        });
        return;
      }

      const [profile] = await ctx.db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);

      const [settings] = await ctx.db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

      res.json({
        id: user.id.toString(),
        username: user.username,
        email: user.email,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt.toISOString(),
        isAdmin: adminService.isAdmin(user.username),
        profile: profile
          ? {
              displayName: profile.displayName,
              avatarHash: profile.avatarHash,
              avatarAnimated: profile.avatarAnimated,
              bannerHash: profile.bannerHash,
              bannerAnimated: profile.bannerAnimated,
              accentColor: profile.accentColor,
              bio: profile.bio,
              pronouns: profile.pronouns,
              avatarDecorationId: profile.avatarDecorationId?.toString() ?? null,
              profileEffectId: profile.profileEffectId?.toString() ?? null,
              nameplateId: profile.nameplateId?.toString() ?? null,
              themePreference: profile.themePreference,
              tier: profile.tier,
              previousAvatarHashes: profile.previousAvatarHashes ?? [],
              messageCount: profile.messageCount,
            }
          : null,
        settings: settings
          ? {
              locale: settings.locale,
              theme: settings.theme,
              messageDisplay: settings.messageDisplay,
              reducedMotion: settings.reducedMotion,
              highContrast: settings.highContrast,
              fontScale: settings.fontScale,
              calmMode: settings.calmMode,
              developerMode: settings.developerMode,
            }
          : null,
      });
    } catch (err) {
      logger.error({ err }, 'Error fetching user profile');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred',
      });
    }
  });

  // ── GET /api/v1/users/presences (batch) ────────────────────────────────
  router.get('/presences', auth, async (req, res) => {
    try {
      const idsParam = String(req.query.ids ?? '').trim();
      if (!idsParam) return res.json([]);

      const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean);
      if (ids.length === 0) return res.json([]);
      if (ids.length > 100) {
        return res.status(400).json({ code: 'TOO_MANY_IDS', message: 'Max 100 ids per request' });
      }

      const presences = await Promise.all(
        ids.map(async (userId) => {
          const [presence, isOnline] = await Promise.all([
            ctx.redis.hgetall(`presence:${userId}`),
            ctx.redis.sismember('online_users', userId),
          ]);
          const rawStatus = String(presence['status'] ?? '').trim();
          const status = rawStatus || (isOnline ? 'online' : 'offline');
          return {
            userId,
            status: status === 'invisible' ? 'offline' : status,
            lastSeen: presence['lastSeen'] ? Number(presence['lastSeen']) : null,
          };
        }),
      );

      res.json(presences);
    } catch (err) {
      logger.error({ err }, 'Error fetching presences');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── PATCH /api/v1/users/@me ────────────────────────────────────────────
  // Update current user's profile
  router.patch('/@me', requireAuth(ctx), async (req, res) => {
    try {
      const userId = BigInt(req.user!.userId);
      const { displayName, bio, pronouns, accentColor, primaryColor } = req.body;

      const updateData: Record<string, unknown> = {};
      if (displayName !== undefined) updateData.displayName = displayName;
      if (bio !== undefined) updateData.bio = bio;
      if (pronouns !== undefined) updateData.pronouns = pronouns;
      if (accentColor !== undefined) updateData.accentColor = accentColor;
      if (primaryColor !== undefined) updateData.primaryColor = primaryColor;

      if (Object.keys(updateData).length === 0) {
        res.status(400).json({
          code: 'NO_CHANGES',
          message: 'No valid fields to update',
        });
        return;
      }

      await ctx.db
        .update(userProfiles)
        .set(updateData)
        .where(eq(userProfiles.userId, userId));

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error updating user profile');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred',
      });
    }
  });

  // ── PATCH /api/v1/users/@me/account ────────────────────────────────────
  // Update account basics used by onboarding flows (username/display name)
  router.patch('/@me/account', requireAuth(ctx), async (req, res) => {
    try {
      const userId = BigInt(req.user!.userId);
      const usernameRaw = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : undefined;
      const displayNameRaw = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : undefined;

      const fieldErrors: Record<string, string[]> = {};

      if (usernameRaw !== undefined) {
        if (!/^[a-z0-9_.-]{2,32}$/.test(usernameRaw)) {
          fieldErrors['username'] = ['Username must be 2-32 characters and use letters, numbers, ., _, or -'];
        } else {
          const [existing] = await ctx.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.username, usernameRaw))
            .limit(1);
          if (existing && existing.id !== userId) {
            fieldErrors['username'] = ['This username is already taken'];
          }
        }
      }

      if (displayNameRaw !== undefined && (displayNameRaw.length < 1 || displayNameRaw.length > 64)) {
        fieldErrors['displayName'] = ['Display name must be between 1 and 64 characters'];
      }

      if (Object.keys(fieldErrors).length > 0) {
        return res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid account data',
          details: fieldErrors,
        });
      }

      if (usernameRaw === undefined && displayNameRaw === undefined) {
        return res.status(400).json({
          code: 'NO_CHANGES',
          message: 'No valid fields to update',
        });
      }

      if (usernameRaw !== undefined) {
        await ctx.db
          .update(users)
          .set({ username: usernameRaw })
          .where(eq(users.id, userId));
      }

      if (displayNameRaw !== undefined) {
        await ctx.db
          .update(userProfiles)
          .set({ displayName: displayNameRaw })
          .where(eq(userProfiles.userId, userId));
      }

      const [user] = await ctx.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const [profile] = await ctx.db
        .select({ displayName: userProfiles.displayName })
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);

      return res.json({
        success: true,
        user: {
          id: user!.id.toString(),
          username: user!.username,
          email: user!.email,
          emailVerified: user!.emailVerified,
        },
        profile: profile ?? null,
      });
    } catch (err) {
      logger.error({ err }, 'Error updating account basics');
      return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── PATCH /api/v1/users/@me/settings ───────────────────────────────────
  // Update current user's settings
  router.patch('/@me/settings', requireAuth(ctx), async (req, res) => {
    try {
      const userId = BigInt(req.user!.userId);
      const allowedFields = [
        'locale',
        'theme',
        'messageDisplay',
        'reducedMotion',
        'highContrast',
        'fontScale',
        'saturation',
        'developerMode',
        'streamerMode',
        'calmMode',
        'allowDmsFrom',
        'allowGroupDmInvitesFrom',
        'allowFriendRequestsFrom',
      ];

      const updateData: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }

      if (Object.keys(updateData).length === 0) {
        res.status(400).json({
          code: 'NO_CHANGES',
          message: 'No valid fields to update',
        });
        return;
      }

      await ctx.db
        .update(userSettings)
        .set(updateData)
        .where(eq(userSettings.userId, userId));

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error updating user settings');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred',
      });
    }
  });

  // ── PATCH /api/v1/users/@me/presence ───────────────────────────────────
  router.patch('/@me/presence', auth, async (req, res) => {
    try {
      const status = String(req.body?.['status'] ?? '').trim();
      if (!allowedPresenceStatuses.has(status)) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid presence status' });
      }

      await ctx.redis.hset(`presence:${req.user!.userId}`, {
        status,
        lastSeen: Date.now().toString(),
      });

      res.json({ status });
    } catch (err) {
      logger.error({ err }, 'Error updating presence');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── Upload global avatar ───────────────────────────────────────────────
  router.post('/@me/avatar', auth, uploadRateLimiter, avatarUpload.single('file'), async (req, res) => {
    try {
      const userId = req.user!.userId;
      if (!req.file) {
        return res.status(400).json({ code: 'NO_FILE' });
      }

      const isGif = req.file!.mimetype === 'image/gif';
      let processed: Buffer;
      let contentType: string;
      let ext: string;

      if (isGif) {
        // Preserve original GIF animation
        processed = req.file!.buffer;
        contentType = 'image/gif';
        ext = 'gif';
      } else {
        // Convert to WebP for static images
        processed = await sharp(req.file!.buffer)
          .rotate()
          .resize(1024, 1024, { fit: 'cover' })
          .webp({ quality: 85 })
          .toBuffer();
        contentType = 'image/webp';
        ext = 'webp';
      }

      const hash = createHash('sha256').update(processed).digest('hex').slice(0, 32);
      const key = `users/${userId}/${hash}.${ext}`;

      await ctx.minio.putObject(BUCKETS.avatars.name, key, processed, processed.length, {
        'Content-Type': contentType,
      });

      const currentProfile = await ctx.db
        .select({ avatarHash: userProfiles.avatarHash, prev: userProfiles.previousAvatarHashes })
        .from(userProfiles)
        .where(eq(userProfiles.userId, BigInt(userId)))
        .then((r: unknown[]) => r[0]);

      const updatedPrev = currentProfile?.avatarHash
        ? [currentProfile.avatarHash, ...(currentProfile.prev ?? [])].slice(0, 5)
        : (currentProfile?.prev ?? []);

      await ctx.db
        .update(userProfiles)
        .set({ avatarHash: `${hash}.${ext}`, avatarAnimated: isGif, previousAvatarHashes: updatedPrev })
        .where(eq(userProfiles.userId, BigInt(userId)));

      res.json({ avatarHash: `${hash}.${ext}`, avatarAnimated: isGif });

    } catch (err) {
      logger.error({ err }, 'Error uploading avatar');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── Remove global avatar ───────────────────────────────────────────────
  router.delete('/@me/avatar', auth, async (req, res) => {
    try {
      const userId = BigInt(req.user!.userId);
      await ctx.db
        .update(userProfiles)
        .set({ avatarHash: null, avatarAnimated: false })
        .where(eq(userProfiles.userId, userId));
      res.status(204).send();
    } catch (err) {
      logger.error({ err }, 'Error removing avatar');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── Restore a previous avatar ──────────────────────────────────────────
  router.post('/@me/avatar/restore', auth, async (req, res) => {
    try {
      const userId = BigInt(req.user!.userId);
      const { hash } = req.body as { hash: string };

      if (!hash || typeof hash !== 'string') {
        return res.status(400).json({ message: 'hash is required' });
      }

      const profile = await ctx.db
        .select({ prev: userProfiles.previousAvatarHashes, avatarHash: userProfiles.avatarHash })
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .then((r: unknown[]) => r[0]);

      if (!profile?.prev?.includes(hash)) {
        return res.status(403).json({ message: 'Hash not in recent avatars' });
      }

      const updatedPrev = profile.avatarHash
        ? [profile.avatarHash, ...profile.prev.filter((h: string) => h !== hash)].slice(0, 5)
        : profile.prev.filter((h: string) => h !== hash);

      await ctx.db
        .update(userProfiles)
        .set({ avatarHash: hash, previousAvatarHashes: updatedPrev })
        .where(eq(userProfiles.userId, userId));

      return res.json({ avatarHash: hash });
    } catch (err) {
      logger.error({ err }, 'Error restoring avatar');
      return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── Upload global banner ───────────────────────────────────────────────
  router.post('/@me/banner', auth, uploadRateLimiter, bannerUpload.single('file'), async (req, res) => {
    try {
      const userId = req.user!.userId;
      if (!req.file) {
        return res.status(400).json({ code: 'NO_FILE' });
      }

      const isGif = req.file!.mimetype === 'image/gif';
      let processed: Buffer;
      let contentType: string;
      let ext: string;

      if (isGif) {
        // Preserve original GIF animation
        processed = req.file!.buffer;
        contentType = 'image/gif';
        ext = 'gif';
      } else {
        // Convert to WebP for static images
        processed = await sharp(req.file!.buffer)
          .rotate()
          .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();
        contentType = 'image/webp';
        ext = 'webp';
      }

      const hash = createHash('sha256').update(processed).digest('hex').slice(0, 32);
      const key = `users/${userId}/${hash}.${ext}`;

      await ctx.minio.putObject(BUCKETS.banners.name, key, processed, processed.length, {
        'Content-Type': contentType,
      });

      await ctx.db
        .update(userProfiles)
        .set({ bannerHash: `${hash}.${ext}`, bannerAnimated: isGif })
        .where(eq(userProfiles.userId, BigInt(userId)));

      res.json({ bannerHash: `${hash}.${ext}`, bannerAnimated: isGif });

    } catch (err) {
      logger.error({ err }, 'Error uploading banner');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── Remove global banner ───────────────────────────────────────────────
  router.delete('/@me/banner', auth, async (req, res) => {
    try {
      const userId = BigInt(req.user!.userId);
      await ctx.db
        .update(userProfiles)
        .set({ bannerHash: null, bannerAnimated: false })
        .where(eq(userProfiles.userId, userId));
      res.status(204).send();
    } catch (err) {
      logger.error({ err }, 'Error removing banner');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── GET /api/v1/users/@me/dnd-schedule ──────────────────────────────────
  router.get('/@me/dnd-schedule', auth, async (req, res) => {
    try {
      const dndService = createDndService(ctx);
      const schedule = await dndService.getSchedule(req.user!.userId);
      res.json(schedule ?? {
        enabled: false,
        startTime: '22:00',
        endTime: '08:00',
        timezone: 'UTC',
        daysOfWeek: 127,
        allowExceptions: [],
      });
    } catch (err) {
      logger.error({ err }, 'Error fetching DND schedule');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── PATCH /api/v1/users/@me/dnd-schedule ────────────────────────────────
  router.patch('/@me/dnd-schedule', auth, async (req, res) => {
    try {
      const allowedFields = ['enabled', 'startTime', 'endTime', 'timezone', 'daysOfWeek', 'allowExceptions'];
      const updateData: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }
      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ code: 'NO_CHANGES', message: 'No valid fields to update' });
      }
      const dndService = createDndService(ctx);
      const result = await dndService.updateSchedule(req.user!.userId, updateData as any);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Error updating DND schedule');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── GET /api/v1/users/:userId/profile ───────────────────────────────
  // Returns public profile data for a specific user
  router.get('/:userId/profile', auth, async (req, res) => {
    try {
      const targetUserId = BigInt(req.params.userId);

      const [row] = await ctx.db
        .select({
          id: users.id,
          username: users.username,
          createdAt: users.createdAt,
          displayName: userProfiles.displayName,
          avatarHash: userProfiles.avatarHash,
          bannerHash: userProfiles.bannerHash,
          bio: userProfiles.bio,
          pronouns: userProfiles.pronouns,
          accentColor: userProfiles.accentColor,
          primaryColor: userProfiles.primaryColor,
          messageCount: userProfiles.messageCount,
          tier: userProfiles.tier,
          widgets: userProfiles.widgets,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(eq(users.id, targetUserId))
        .limit(1);

      if (!row) {
        return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'User not found' });
      }

      // Compute badges
      const badges: string[] = [];
      if (row.tier === 'crystalline') badges.push('Crystalline');
      if (new Date(row.createdAt).getFullYear() <= 2024) badges.push('OG');
      if (adminService.isAdmin(row.username)) badges.push('Staff');

      res.json({
        id: row.id.toString(),
        username: row.username,
        displayName: row.displayName,
        avatarHash: row.avatarHash,
        bannerHash: row.bannerHash,
        bio: row.bio,
        pronouns: row.pronouns,
        accentColor: row.accentColor,
        primaryColor: row.primaryColor,
        messageCount: row.messageCount ?? 0,
        createdAt: row.createdAt.toISOString(),
        tier: row.tier,
        widgets: row.widgets ?? [],
        badges,
      });
    } catch (err) {
      logger.error({ err }, 'Error fetching user profile');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── PATCH /api/v1/users/@me/status ──────────────────────────────────
  router.patch('/@me/status', auth, async (req, res) => {
    try {
      const userId = req.user!.userId;
      const text: string | null = typeof req.body?.text === 'string' ? req.body.text.slice(0, 128) : null;
      const expiresAt: Date | null = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;

      await ctx.db
        .insert(userCustomStatus)
        .values({ userId, text, expiresAt })
        .onConflictDoUpdate({
          target: userCustomStatus.userId,
          set: { text, expiresAt },
        });

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error updating custom status');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── PATCH /api/v1/users/@me/widgets ─────────────────────────────────
  router.patch('/@me/widgets', auth, async (req, res) => {
    try {
      const userId = req.user!.userId;
      const widgets = Array.isArray(req.body?.widgets)
        ? (req.body.widgets as unknown[]).filter((w): w is string => typeof w === 'string').slice(0, 8)
        : [];

      await ctx.db
        .update(userProfiles)
        .set({ widgets })
        .where(eq(userProfiles.userId, userId));

      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Error updating widgets');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  // ── GET /api/v1/users/:userId/mutuals ───────────────────────────────
  router.get('/:userId/mutuals', auth, async (req, res) => {
    try {
      const currentUserId = BigInt(req.user!.userId);
      const targetUserId = BigInt(req.params.userId);

      // --- Mutual friends ---
      const [currentFriendRows, targetFriendRows] = await Promise.all([
        ctx.db
          .select({ targetId: relationships.targetId })
          .from(relationships)
          .where(and(eq(relationships.userId, currentUserId), eq(relationships.type, 'friend'))),
        ctx.db
          .select({ targetId: relationships.targetId })
          .from(relationships)
          .where(and(eq(relationships.userId, targetUserId), eq(relationships.type, 'friend'))),
      ]);

      const currentFriendIds = new Set(currentFriendRows.map((r) => r.targetId.toString()));
      const mutualFriendIds = targetFriendRows
        .map((r) => r.targetId)
        .filter((id) => currentFriendIds.has(id.toString()));

      let mutualFriends: Array<{ id: string; username: string; displayName: string; avatarHash: string | null }> = [];
      if (mutualFriendIds.length > 0) {
        const friendRows = await ctx.db
          .select({
            id: users.id,
            username: users.username,
            displayName: userProfiles.displayName,
            avatarHash: userProfiles.avatarHash,
          })
          .from(users)
          .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
          .where(inArray(users.id, mutualFriendIds));

        mutualFriends = friendRows.map((row) => ({
          id: row.id.toString(),
          username: row.username,
          displayName: row.displayName,
          avatarHash: row.avatarHash,
        }));
      }

      // --- Mutual servers ---
      const [currentGuildRows, targetGuildRows] = await Promise.all([
        ctx.db
          .select({ guildId: guildMembers.guildId })
          .from(guildMembers)
          .where(eq(guildMembers.userId, currentUserId)),
        ctx.db
          .select({ guildId: guildMembers.guildId, nickname: guildMembers.nickname })
          .from(guildMembers)
          .where(eq(guildMembers.userId, targetUserId)),
      ]);

      const currentGuildIds = new Set(currentGuildRows.map((r) => r.guildId.toString()));
      const mutualGuildEntries = targetGuildRows.filter((r) => currentGuildIds.has(r.guildId.toString()));
      const mutualGuildIds = mutualGuildEntries.map((r) => r.guildId);

      let mutualServers: Array<{ id: string; name: string; iconHash: string | null; nickname: string | null }> = [];
      if (mutualGuildIds.length > 0) {
        const nicknameByGuildId = new Map(mutualGuildEntries.map((r) => [r.guildId.toString(), r.nickname]));
        const guildRows = await ctx.db
          .select({
            id: guilds.id,
            name: guilds.name,
            iconHash: guilds.iconHash,
          })
          .from(guilds)
          .where(inArray(guilds.id, mutualGuildIds));

        mutualServers = guildRows.map((row) => ({
          id: row.id.toString(),
          name: row.name,
          iconHash: row.iconHash,
          nickname: nicknameByGuildId.get(row.id.toString()) ?? null,
        }));
      }

      res.json({ mutualServers, mutualFriends });
    } catch (err) {
      logger.error({ err }, 'Error fetching mutuals');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred' });
    }
  });

  return router;
}
