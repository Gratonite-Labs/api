import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import multer from 'multer';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { guilds as guildsTable } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { uploadRateLimiter } from '../../middleware/rate-limiter.js';
import { BUCKETS } from '../../lib/minio.js';
import { createGuildsService } from './guilds.service.js';
import { createGuildSchema, updateGuildSchema, createRoleSchema, updateRoleSchema } from './guilds.schemas.js';
import {
  createEmojiSchema,
  updateEmojiSchema,
  createStickerSchema,
  updateStickerSchema,
} from './emojis.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

const emojiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS.emojis.maxSize },
});

const stickerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS.stickers.maxSize },
});

const guildIconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS['server-icons'].maxSize },
});

const guildBannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BUCKETS.banners.maxSize },
});

export function guildsRouter(ctx: AppContext): Router {
  const router = Router();
  const guildsService = createGuildsService(ctx);
  const auth = requireAuth(ctx);

  // ── Guild CRUD ─────────────────────────────────────────────────────────

  // Create guild
  router.post('/', auth, async (req, res) => {
    const parsed = createGuildSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await guildsService.createGuild(req.user!.userId, parsed.data);
    const guild = await guildsService.getGuild(result.guildId);

    ctx.io.to(`user:${req.user!.userId}`).emit('GUILD_CREATE', guild as any);

    res.status(201).json(guild);
  });

  // Get current user's guilds
  router.get('/@me', auth, async (req, res) => {
    const userGuilds = await guildsService.getUserGuilds(req.user!.userId);
    res.json(userGuilds);
  });

  // Get guild by ID
  router.get('/:guildId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER', message: 'You are not a member of this server' });
    }

    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    res.json(guild);
  });

  // Update guild
  router.patch('/:guildId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    // Only owner can update guild settings
    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the server owner can modify settings' });
    }

    const parsed = updateGuildSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await guildsService.updateGuild(guildId, parsed.data);
    if (updated) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_UPDATE',
        updated as any,
      );
    }

    res.json(updated);
  });

  // Upload guild icon
  router.post('/:guildId/icon', auth, uploadRateLimiter, guildIconUpload.single('file'), async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });
    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the server owner can modify settings' });
    }
    if (!req.file) return res.status(400).json({ code: 'NO_FILE', message: 'No file provided' });

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
        .resize(512, 512, { fit: 'cover' })
        .webp({ quality: 85 })
        .toBuffer();
      contentType = 'image/webp';
      ext = 'webp';
    }

    const hash = createHash('sha256').update(processed).digest('hex').slice(0, 32);
    const key = `guilds/${guildId}/${hash}.${ext}`;

    await ctx.minio.putObject(BUCKETS['server-icons'].name, key, processed, processed.length, {
      'Content-Type': contentType,
    });

    const [updated] = await ctx.db
      .update(guildsTable)
      .set({ iconHash: `${hash}.${ext}`, iconAnimated: isGif })
      .where(eq(guildsTable.id, BigInt(guildId)))
      .returning();

    if (updated) {
      await guildsService.invalidateGuildCache(guildId);
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_UPDATE',
        updated as any,
      );
    }

    res.status(201).json({ iconHash: `${hash}.${ext}`, iconAnimated: isGif });

  });

  // Remove guild icon
  router.delete('/:guildId/icon', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });
    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the server owner can modify settings' });
    }

    const [updated] = await ctx.db
      .update(guildsTable)
      .set({ iconHash: null, iconAnimated: false })
      .where(eq(guildsTable.id, BigInt(guildId)))
      .returning();

    if (updated) {
      await guildsService.invalidateGuildCache(guildId);
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_UPDATE',
        updated as any,
      );
    }

    res.status(204).send();
  });

  // Upload guild banner
  router.post('/:guildId/banner', auth, uploadRateLimiter, guildBannerUpload.single('file'), async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });
    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the server owner can modify settings' });
    }
    if (!req.file) return res.status(400).json({ code: 'NO_FILE', message: 'No file provided' });

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
        .resize(1920, 1080, { fit: 'cover' })
        .webp({ quality: 85 })
        .toBuffer();
      contentType = 'image/webp';
      ext = 'webp';
    }

    const hash = createHash('sha256').update(processed).digest('hex').slice(0, 32);
    const key = `guilds/${guildId}/${hash}.${ext}`;

    await ctx.minio.putObject(BUCKETS.banners.name, key, processed, processed.length, {
      'Content-Type': contentType,
    });

    const [updated] = await ctx.db
      .update(guildsTable)
      .set({ bannerHash: `${hash}.${ext}`, bannerAnimated: isGif })
      .where(eq(guildsTable.id, BigInt(guildId)))
      .returning();

    if (updated) {
      await guildsService.invalidateGuildCache(guildId);
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_UPDATE',
        updated as any,
      );
    }

    res.status(201).json({ bannerHash: `${hash}.${ext}`, bannerAnimated: isGif });

  });

  // Remove guild banner
  router.delete('/:guildId/banner', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });
    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the server owner can modify settings' });
    }

    const [updated] = await ctx.db
      .update(guildsTable)
      .set({ bannerHash: null, bannerAnimated: false })
      .where(eq(guildsTable.id, BigInt(guildId)))
      .returning();

    if (updated) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_UPDATE',
        updated as any,
      );
    }

    res.status(204).send();
  });

  // Delete guild
  router.delete('/:guildId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the server owner can delete the server' });
    }

    await guildsService.deleteGuild(guildId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_DELETE',
      { id: String(guildId) },
    );

    res.status(204).send();
  });

  // ── Members ──────────────────────────────────────────────────────────────

  // List members
  router.get('/:guildId/members', auth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const after = req.query.after ? req.query.after as string : undefined;
    const members = await guildsService.getMembers(guildId, limit, after);
    res.json(members);
  });

  // Get specific member
  router.get('/:guildId/members/:userId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const member = await guildsService.getMember(guildId, req.params.userId);
    if (!member) return res.status(404).json({ code: 'NOT_FOUND' });

    res.json(member);
  });

  // Leave guild
  router.delete('/:guildId/members/@me', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const userId = req.user!.userId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId === userId) {
      return res.status(400).json({ code: 'OWNER_CANNOT_LEAVE', message: 'Transfer ownership before leaving' });
    }

    await guildsService.removeMember(guildId, userId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_MEMBERS,
      'GUILD_MEMBER_REMOVE',
      { userId: String(userId), guildId: String(guildId) },
    );

    res.status(204).send();
  });

  // Kick member
  router.delete('/:guildId/members/:userId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const targetId = req.params.userId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    // TODO: Check KICK_MEMBERS permission instead of just owner check
    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    if (targetId === guild.ownerId) {
      return res.status(400).json({ code: 'CANNOT_KICK_OWNER' });
    }

    await guildsService.removeMember(guildId, targetId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_MEMBERS,
      'GUILD_MEMBER_REMOVE',
      { userId: String(targetId), guildId: String(guildId) },
    );

    res.status(204).send();
  });

  // ── Roles ────────────────────────────────────────────────────────────────

  // List roles
  router.get('/:guildId/roles', auth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const roles = await guildsService.getRoles(guildId);
    res.json(roles);
  });

  // Create role
  router.post('/:guildId/roles', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    // TODO: Check MANAGE_ROLES permission
    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const role = await guildsService.createRole(guildId, parsed.data);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_ROLE_CREATE',
      { guildId: String(guildId), role },
    );

    res.status(201).json(role);
  });

  // Update role
  router.patch('/:guildId/roles/:roleId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const role = await guildsService.updateRole(req.params.roleId, parsed.data);
    if (!role) return res.status(404).json({ code: 'NOT_FOUND' });

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_ROLE_UPDATE',
      { guildId: String(guildId), role },
    );

    res.json(role);
  });

  // Delete role
  router.delete('/:guildId/roles/:roleId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await guildsService.deleteRole(req.params.roleId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_ROLE_DELETE',
      { guildId: String(guildId), roleId: req.params.roleId },
    );

    res.status(204).send();
  });

  // Assign role to member
  router.get('/:guildId/members/:userId/roles', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const userId = req.params.userId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }
    if (!await guildsService.isMember(guildId, userId)) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }
    const roles = await guildsService.getMemberRoles(guildId, userId);
    res.json(roles);
  });

  // Assign role to member
  router.put('/:guildId/members/:userId/roles/:roleId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await guildsService.assignRole(guildId, req.params.userId, req.params.roleId);
    res.status(204).send();
  });

  // Remove role from member
  router.delete('/:guildId/members/:userId/roles/:roleId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await guildsService.removeRole(guildId, req.params.userId, req.params.roleId);
    res.status(204).send();
  });

  // ── Bans ─────────────────────────────────────────────────────────────────

  // List bans
  router.get('/:guildId/bans', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const banList = await guildsService.getBans(guildId);
    res.json(banList);
  });

  // Ban member
  router.put('/:guildId/bans/:userId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const targetId = req.params.userId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    if (targetId === guild.ownerId) {
      return res.status(400).json({ code: 'CANNOT_BAN_OWNER' });
    }

    await guildsService.banMember(guildId, targetId, req.user!.userId, req.body?.reason);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_MEMBERS,
      'GUILD_BAN_ADD',
      { guildId: String(guildId), userId: String(targetId) },
    );

    res.status(204).send();
  });

  // Unban member
  router.delete('/:guildId/bans/:userId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await guildsService.unbanMember(guildId, req.params.userId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_MEMBERS,
      'GUILD_BAN_REMOVE',
      { guildId: String(guildId), userId: req.params.userId },
    );

    res.status(204).send();
  });

  // ── Emojis ──────────────────────────────────────────────────────────────

  // List guild emojis (any member can view)
  router.get('/:guildId/emojis', auth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const emojis = await guildsService.getGuildEmojis(guildId);
    res.json(emojis);
  });

  // Upload emoji (any member can upload — like Discord)
  router.post('/:guildId/emojis', auth, uploadRateLimiter, emojiUpload.single('file'), async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    if (!req.file) {
      return res.status(400).json({ code: 'NO_FILE', message: 'No file provided' });
    }

    // Validate body
    const parsed = createEmojiSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    // Validate MIME type via magic bytes
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(req.file.buffer);
    const mimeType = detected?.mime ?? req.file.mimetype;
    const allowed = ['image/png', 'image/gif', 'image/webp'];
    if (!allowed.some((t) => mimeType.startsWith(t))) {
      return res.status(415).json({ code: 'INVALID_FILE_TYPE', message: `Emoji must be PNG, GIF, or WebP` });
    }

    const animated = mimeType === 'image/gif';

    // Process: resize to 128x128 for non-animated, just validate dimensions for animated
    let buffer = req.file.buffer;
    if (!animated) {
      const processed = await sharp(buffer)
        .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 90 })
        .toBuffer();
      buffer = processed;
    }

    // Upload to MinIO
    const hash = createHash('sha256')
      .update(req.file.originalname + Date.now() + randomBytes(8).toString('hex'))
      .digest('hex')
      .slice(0, 32);
    const ext = animated ? 'gif' : 'webp';
    const key = `${guildId}/${hash}.${ext}`;

    await ctx.minio.putObject(BUCKETS.emojis.name, key, buffer, buffer.length, {
      'Content-Type': animated ? 'image/gif' : 'image/webp',
    });

    const emoji = await guildsService.createEmoji(guildId, req.user!.userId, parsed.data, `${hash}.${ext}`, animated);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_EMOJI_CREATE',
      { guildId: String(guildId), emoji } as any,
    );

    res.status(201).json(emoji);
  });

  // Update emoji metadata (owner or MANAGE_EMOJIS permission)
  router.patch('/:guildId/emojis/:emojiId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const emoji = await guildsService.getEmoji(req.params.emojiId);
    if (!emoji || emoji.guildId !== guildId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    // Only the creator or guild owner can update
    const guild = await guildsService.getGuild(guildId);
    if (emoji.creatorId !== req.user!.userId && guild?.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the emoji creator or server owner can update this emoji' });
    }

    const parsed = updateEmojiSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await guildsService.updateEmoji(req.params.emojiId, parsed.data);
    if (updated) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_EMOJI_UPDATE',
        { guildId: String(guildId), emoji: updated } as any,
      );
    }

    res.json(updated);
  });

  // Delete emoji (owner or MANAGE_EMOJIS permission)
  router.delete('/:guildId/emojis/:emojiId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const emoji = await guildsService.getEmoji(req.params.emojiId);
    if (!emoji || emoji.guildId !== guildId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    // Only the creator or guild owner can delete
    const guild = await guildsService.getGuild(guildId);
    if (emoji.creatorId !== req.user!.userId && guild?.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the emoji creator or server owner can delete this emoji' });
    }

    await guildsService.deleteEmoji(req.params.emojiId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_EMOJI_DELETE',
      { guildId: String(guildId), emojiId: req.params.emojiId },
    );

    res.status(204).send();
  });

  // ── Stickers ────────────────────────────────────────────────────────────

  // List guild stickers (any member can view)
  router.get('/:guildId/stickers', auth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const stickers = await guildsService.getGuildStickers(guildId);
    res.json(stickers);
  });

  // Upload sticker (any member can upload)
  router.post('/:guildId/stickers', auth, uploadRateLimiter, stickerUpload.single('file'), async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    if (!req.file) {
      return res.status(400).json({ code: 'NO_FILE', message: 'No file provided' });
    }

    // Validate body
    const parsed = createStickerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    // Validate MIME type via magic bytes
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(req.file.buffer);
    const mimeType = detected?.mime ?? req.file.mimetype;
    const allowed = ['image/png', 'image/gif', 'image/webp', 'image/apng', 'application/json'];
    if (!allowed.some((t) => mimeType.startsWith(t))) {
      return res.status(415).json({ code: 'INVALID_FILE_TYPE', message: 'Sticker must be PNG, GIF, WebP, APNG, or Lottie JSON' });
    }

    // Determine format type
    let formatType: string;
    if (mimeType === 'image/gif') formatType = 'gif';
    else if (mimeType === 'image/apng') formatType = 'apng';
    else if (mimeType === 'application/json') formatType = 'lottie';
    else if (mimeType === 'image/webp') formatType = 'webp';
    else formatType = 'png';

    // Process: resize to max 320x320 for static images
    let buffer = req.file.buffer;
    const isStaticImage = ['png', 'webp'].includes(formatType);
    if (isStaticImage) {
      buffer = await sharp(buffer)
        .resize(320, 320, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 90 })
        .toBuffer();
      formatType = 'webp';
    }

    // Upload to MinIO
    const hash = createHash('sha256')
      .update(req.file.originalname + Date.now() + randomBytes(8).toString('hex'))
      .digest('hex')
      .slice(0, 32);
    const ext = formatType === 'lottie' ? 'json' : formatType;
    const key = `${guildId}/${hash}.${ext}`;

    await ctx.minio.putObject(BUCKETS.stickers.name, key, buffer, buffer.length, {
      'Content-Type': mimeType,
    });

    const sticker = await guildsService.createSticker(guildId, req.user!.userId, parsed.data, `${hash}.${ext}`, formatType);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_STICKER_CREATE',
      { guildId: String(guildId), sticker } as any,
    );

    res.status(201).json(sticker);
  });

  // Update sticker metadata
  router.patch('/:guildId/stickers/:stickerId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    if (!await guildsService.isMember(guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const sticker = await guildsService.getSticker(req.params.stickerId);
    if (!sticker || sticker.guildId !== guildId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    // Only the creator or guild owner can update
    const guild = await guildsService.getGuild(guildId);
    if (sticker.creatorId !== req.user!.userId && guild?.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the sticker creator or server owner can update this sticker' });
    }

    const parsed = updateStickerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await guildsService.updateSticker(req.params.stickerId, parsed.data);
    if (updated) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${guildId}`,
        GatewayIntents.GUILDS,
        'GUILD_STICKER_UPDATE',
        { guildId: String(guildId), sticker: updated } as any,
      );
    }

    res.json(updated);
  });

  // Delete sticker
  router.delete('/:guildId/stickers/:stickerId', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const sticker = await guildsService.getSticker(req.params.stickerId);
    if (!sticker || sticker.guildId !== guildId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    // Only the creator or guild owner can delete
    const guild = await guildsService.getGuild(guildId);
    if (sticker.creatorId !== req.user!.userId && guild?.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only the sticker creator or server owner can delete this sticker' });
    }

    await guildsService.deleteSticker(req.params.stickerId);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'GUILD_STICKER_DELETE',
      { guildId: String(guildId), stickerId: req.params.stickerId },
    );

    res.status(204).send();
  });

  // ── Discord Import ───────────────────────────────────────────────────

  const importUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  });

  // Preview Discord export (parse only, no creation)
  router.post('/import/discord', auth, importUpload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ code: 'NO_FILE', message: 'File required' });
    }

    try {
      const data = JSON.parse(req.file.buffer.toString('utf8'));
      const parsed = guildsService.parseDiscordExport(data);
      return res.json(parsed);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return res.status(400).json({ code: 'INVALID_JSON', message: 'File is not valid JSON' });
      }
      if (err instanceof Error && err.message === 'INVALID_FORMAT') {
        return res.status(400).json({ code: 'INVALID_FORMAT', message: 'Unrecognized Discord export format' });
      }
      throw err;
    }
  });

  // Confirm and create guild from Discord import
  router.post('/import/discord/confirm', auth, async (req, res) => {
    const { name, categories, roles } = req.body;

    if (!name || !Array.isArray(categories)) {
      return res.status(400).json({ code: 'INVALID_INPUT', message: 'name and categories required' });
    }

    try {
      const result = await guildsService.createGuildFromImport(req.user!.userId, { name, categories, roles: roles ?? [] });
      return res.status(201).json(result);
    } catch (err) {
      throw err;
    }
  });

  return router;
}
