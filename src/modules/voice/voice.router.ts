import { Router } from 'express';
import multer from 'multer';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createVoiceService } from './voice.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { createChannelsService } from '../channels/channels.service.js';
import { createMessagesService } from '../messages/messages.service.js';
import { createFilesService } from '../files/files.service.js';
import { dmRecipients, dmChannels, channels, messages, messageAttachments } from '@gratonite/db';
import { and, eq, desc, sql } from 'drizzle-orm';
import { generateId } from '../../lib/snowflake.js';

const voiceMessageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});
import {
  joinVoiceSchema,
  updateVoiceStateSchema,
  modifyMemberVoiceStateSchema,
  createStageInstanceSchema,
  updateStageInstanceSchema,
  createSoundboardSoundSchema,
  updateSoundboardSoundSchema,
  startScreenShareSchema,
} from './voice.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';
import { hasPermission, PermissionFlags } from '@gratonite/types';

export function voiceRouter(ctx: AppContext): Router {
  const router = Router();
  const voiceService = createVoiceService(ctx);
  const guildsService = createGuildsService(ctx);
  const channelsService = createChannelsService(ctx);
  const messagesService = createMessagesService(ctx);
  const filesService = createFilesService(ctx);
  const auth = requireAuth(ctx);

  // ── Join voice channel ──────────────────────────────────────────────────

  router.post('/voice/join', auth, async (req, res) => {
    const parsed = joinVoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const userId = req.user!.userId;
    let channel = await channelsService.getChannel(parsed.data.channelId);
    if (!channel) {
      const [dmChannel] = await ctx.db
        .select()
        .from(dmChannels)
        .where(eq(dmChannels.id, parsed.data.channelId))
        .limit(1);
      if (dmChannel) {
        await ctx.db
          .insert(channels)
          .values({
            id: dmChannel.id,
            type: dmChannel.type === 'group_dm' ? 'GROUP_DM' : 'DM',
            name: dmChannel.name ?? null,
          })
          .onConflictDoNothing();
        channel = await channelsService.getChannel(parsed.data.channelId);
      }
    }
    if (!channel) return res.status(404).json({ code: 'NOT_FOUND', message: 'Channel not found' });

    const isGuildVoice = channel.type === 'GUILD_VOICE' || channel.type === 'GUILD_STAGE_VOICE';
    const isDmVoice = channel.type === 'DM' || channel.type === 'GROUP_DM';
    if (!isGuildVoice && !isDmVoice) {
      return res.status(400).json({ code: 'INVALID_CHANNEL_TYPE', message: 'Not a voice channel' });
    }

    // Must be a guild member for guild voice
    if (channel.guildId) {
      const isMember = await guildsService.isMember(channel.guildId, userId);
      if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });
      const canConnect = await channelsService.canConnectToVoiceChannel(channel.id, userId);
      if (!canConnect) return res.status(403).json({ code: 'FORBIDDEN' });
    }

    // Must be a DM recipient for DM calls
    if (!channel.guildId && isDmVoice) {
      const [recipient] = await ctx.db
        .select({ userId: dmRecipients.userId })
        .from(dmRecipients)
        .innerJoin(dmChannels, eq(dmChannels.id, dmRecipients.channelId))
        .where(and(eq(dmRecipients.channelId, channel.id), eq(dmRecipients.userId, userId)))
        .limit(1);
      if (!recipient) return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const { token, voiceState } = await voiceService.joinChannel(
      userId,
      req.user!.username,
      parsed.data.channelId,
      channel.guildId,
      `session_${userId}`,
      parsed.data,
    );

    // Broadcast voice state to guild
    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_VOICE_STATES,
        'VOICE_STATE_UPDATE',
        voiceState as any,
      );
    }

    res.json({
      token,
      voiceState,
      endpoint: ctx.env.LIVEKIT_URL,
    });
  });

  // ── Leave voice channel ─────────────────────────────────────────────────

  router.post('/voice/leave', auth, async (req, res) => {
    const userId = req.user!.userId;
    const disconnectedState = await voiceService.leaveChannel(userId);

    if (!disconnectedState) {
      return res.status(400).json({ code: 'NOT_IN_VOICE', message: 'Not in a voice channel' });
    }

    if (disconnectedState.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${disconnectedState.guildId}`,
        GatewayIntents.GUILD_VOICE_STATES,
        'VOICE_STATE_UPDATE',
        disconnectedState as any,
      );
    }

    res.status(204).send();
  });

  // ── Update own voice state ──────────────────────────────────────────────

  router.patch('/voice/state', auth, async (req, res) => {
    const parsed = updateVoiceStateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await voiceService.updateVoiceState(req.user!.userId, parsed.data);
    if (!updated) return res.status(404).json({ code: 'NOT_IN_VOICE', message: 'Not in a voice channel' });

    if (updated.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${updated.guildId}`,
        GatewayIntents.GUILD_VOICE_STATES,
        'VOICE_STATE_UPDATE',
        updated as any,
      );
    }

    res.json(updated);
  });

  // ── Get guild voice states ──────────────────────────────────────────────

  router.get('/guilds/:guildId/voice-states', auth, async (req, res) => {
    const { guildId } = req.params;
    const isMember = await guildsService.isMember(guildId, req.user!.userId);
    if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });

    const states = await voiceService.getGuildVoiceStates(guildId);
    res.json(states);
  });

  // ── Get channel voice states ────────────────────────────────────────────

  router.get('/channels/:channelId/voice-states', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ code: 'NOT_FOUND' });

    if (channel.guildId) {
      const isMember = await guildsService.isMember(channel.guildId, req.user!.userId);
      if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });
      const canConnect = await channelsService.canConnectToVoiceChannel(channel.id, req.user!.userId);
      if (!canConnect) return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const states = await voiceService.getChannelVoiceStates(req.params.channelId);
    res.json(states);
  });

  // ── Modify member voice state (mod action) ──────────────────────────────

  router.patch('/guilds/:guildId/voice-states/:userId', auth, async (req, res) => {
    const { guildId, userId: targetUserId } = req.params;

    const perms = await guildsService.getMemberPermissions(guildId, req.user!.userId);
    if (!hasPermission(perms, PermissionFlags.MUTE_MEMBERS) &&
        !hasPermission(perms, PermissionFlags.DEAFEN_MEMBERS) &&
        !hasPermission(perms, PermissionFlags.MOVE_MEMBERS)) {
      return res.status(403).json({ code: 'MISSING_PERMISSIONS' });
    }

    const parsed = modifyMemberVoiceStateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const result = await voiceService.modifyMemberVoiceState(targetUserId, parsed.data);
    if (!result) return res.status(404).json({ code: 'NOT_IN_VOICE' });

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_VOICE_STATES,
      'VOICE_STATE_UPDATE',
      result as any,
    );

    res.json(result);
  });

  // ── Screen share ────────────────────────────────────────────────────────

  router.post('/voice/screen-share/start', auth, async (req, res) => {
    const parsed = startScreenShareSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const state = await voiceService.getVoiceState(req.user!.userId);
    if (!state) return res.status(400).json({ code: 'NOT_IN_VOICE', message: 'Not in a voice channel' });

    const session = await voiceService.startScreenShare(
      req.user!.userId,
      state.channelId,
      parsed.data,
    );

    if (state.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${state.guildId}`,
        GatewayIntents.GUILD_VOICE_STATES,
        'SCREEN_SHARE_START',
        session as any,
      );
      await emitRoomWithIntent(
        ctx.io,
        `guild:${state.guildId}`,
        GatewayIntents.GUILD_VOICE_STATES,
        'VOICE_STATE_UPDATE',
        {
          ...state,
          selfStream: true,
        } as any,
      );
    }

    res.json(session);
  });

  router.post('/voice/screen-share/stop', auth, async (req, res) => {
    const state = await voiceService.getVoiceState(req.user!.userId);
    if (!state) return res.status(400).json({ code: 'NOT_IN_VOICE' });

    await voiceService.stopScreenShare(req.user!.userId, state.channelId);

    if (state.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${state.guildId}`,
        GatewayIntents.GUILD_VOICE_STATES,
        'SCREEN_SHARE_STOP',
        {
          userId: req.user!.userId,
          channelId: state.channelId,
        } as any,
      );
      await emitRoomWithIntent(
        ctx.io,
        `guild:${state.guildId}`,
        GatewayIntents.GUILD_VOICE_STATES,
        'VOICE_STATE_UPDATE',
        {
          ...state,
          selfStream: false,
        } as any,
      );
    }

    res.status(204).send();
  });

  // ── Stage instances ─────────────────────────────────────────────────────

  router.post('/guilds/:guildId/stage-instances', auth, async (req, res) => {
    const { guildId } = req.params;
    const perms = await guildsService.getMemberPermissions(guildId, req.user!.userId);
    if (!hasPermission(perms, PermissionFlags.MANAGE_CHANNELS)) {
      return res.status(403).json({ code: 'MISSING_PERMISSIONS' });
    }

    const parsed = createStageInstanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const stage = await voiceService.createStageInstance(guildId, parsed.data);

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_VOICE_STATES,
      'STAGE_INSTANCE_CREATE',
      stage as any,
    );

    res.status(201).json(stage);
  });

  router.get('/guilds/:guildId/stage-instances', auth, async (req, res) => {
    const { guildId } = req.params;
    const isMember = await guildsService.isMember(guildId, req.user!.userId);
    if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });

    const stages = await voiceService.getGuildStageInstances(guildId);
    res.json(stages);
  });

  router.patch('/stage-instances/:stageId', auth, async (req, res) => {
    const parsed = updateStageInstanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await voiceService.updateStageInstance(req.params.stageId, parsed.data);
    if (!updated) return res.status(404).json({ code: 'NOT_FOUND' });

    await emitRoomWithIntent(
      ctx.io,
      `guild:${updated.guildId}`,
      GatewayIntents.GUILD_VOICE_STATES,
      'STAGE_INSTANCE_UPDATE',
      updated as any,
    );

    res.json(updated);
  });

  router.delete('/stage-instances/:stageId', auth, async (req, res) => {
    const stage = await voiceService.getStageInstanceById(req.params.stageId);
    if (!stage) return res.status(404).json({ code: 'NOT_FOUND' });

    const perms = await guildsService.getMemberPermissions(stage.guildId, req.user!.userId);
    if (!hasPermission(perms, PermissionFlags.MANAGE_CHANNELS)) {
      return res.status(403).json({ code: 'MISSING_PERMISSIONS' });
    }

    await voiceService.deleteStageInstance(req.params.stageId);

    await emitRoomWithIntent(
      ctx.io,
      `guild:${stage.guildId}`,
      GatewayIntents.GUILD_VOICE_STATES,
      'STAGE_INSTANCE_DELETE',
      {
        id: stage.id,
        guildId: stage.guildId,
        channelId: stage.channelId,
      } as any,
    );

    res.status(204).send();
  });

  // Request to speak (stage channel)
  router.put('/stage-instances/:stageId/request-to-speak', auth, async (req, res) => {
    const updated = await voiceService.requestToSpeak(req.user!.userId);
    if (!updated) return res.status(404).json({ code: 'NOT_IN_VOICE' });

    if (updated.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${updated.guildId}`,
        GatewayIntents.GUILD_VOICE_STATES,
        'VOICE_STATE_UPDATE',
        updated as any,
      );
    }

    res.status(204).send();
  });

  // Approve speaker
  router.put('/stage-instances/:stageId/speakers/:userId', auth, async (req, res) => {
    const state = await voiceService.getVoiceState(req.params.userId);
    if (!state || !state.guildId) return res.status(404).json({ code: 'NOT_FOUND' });

    const perms = await guildsService.getMemberPermissions(state.guildId, req.user!.userId);
    if (!hasPermission(perms, PermissionFlags.MUTE_MEMBERS)) {
      return res.status(403).json({ code: 'MISSING_PERMISSIONS' });
    }

    const updated = await voiceService.approveSpeaker(req.params.userId);
    if (!updated) return res.status(404).json({ code: 'NOT_IN_VOICE' });

    await emitRoomWithIntent(
      ctx.io,
      `guild:${state.guildId}`,
      GatewayIntents.GUILD_VOICE_STATES,
      'VOICE_STATE_UPDATE',
      updated as any,
    );

    res.status(204).send();
  });

  // Revoke speaker
  router.delete('/stage-instances/:stageId/speakers/:userId', auth, async (req, res) => {
    const state = await voiceService.getVoiceState(req.params.userId);
    if (!state || !state.guildId) return res.status(404).json({ code: 'NOT_FOUND' });

    const perms = await guildsService.getMemberPermissions(state.guildId, req.user!.userId);
    if (!hasPermission(perms, PermissionFlags.MUTE_MEMBERS)) {
      return res.status(403).json({ code: 'MISSING_PERMISSIONS' });
    }

    const updated = await voiceService.revokeSpeaker(req.params.userId);
    if (!updated) return res.status(404).json({ code: 'NOT_IN_VOICE' });

    await emitRoomWithIntent(
      ctx.io,
      `guild:${state.guildId}`,
      GatewayIntents.GUILD_VOICE_STATES,
      'VOICE_STATE_UPDATE',
      updated as any,
    );

    res.status(204).send();
  });

  // ── Soundboard ──────────────────────────────────────────────────────────

  router.get('/guilds/:guildId/soundboard', auth, async (req, res) => {
    const { guildId } = req.params;
    const isMember = await guildsService.isMember(guildId, req.user!.userId);
    if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });

    const sounds = await voiceService.getGuildSounds(guildId);
    res.json(sounds);
  });

  router.post('/guilds/:guildId/soundboard', auth, async (req, res) => {
    const { guildId } = req.params;
    const isMember = await guildsService.isMember(guildId, req.user!.userId);
    if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });

    const parsed = createSoundboardSoundSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const sound = await voiceService.createSound(guildId, req.user!.userId, parsed.data);
    res.status(201).json(sound);
  });

  router.patch('/guilds/:guildId/soundboard/:soundId', auth, async (req, res) => {
    const sound = await voiceService.getSound(req.params.soundId);
    if (!sound || sound.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    // Only uploader or guild owner can update
    const guild = await guildsService.getGuild(req.params.guildId);
    if (sound.uploaderId !== req.user!.userId && guild?.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = updateSoundboardSoundSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await voiceService.updateSound(req.params.soundId, parsed.data);
    res.json(updated);
  });

  router.delete('/guilds/:guildId/soundboard/:soundId', auth, async (req, res) => {
    const sound = await voiceService.getSound(req.params.soundId);
    if (!sound || sound.guildId !== req.params.guildId) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    const guild = await guildsService.getGuild(req.params.guildId);
    if (sound.uploaderId !== req.user!.userId && guild?.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await voiceService.deleteSound(req.params.soundId);
    res.status(204).send();
  });

  // Play soundboard sound in voice channel
  router.post('/guilds/:guildId/soundboard/:soundId/play', auth, async (req, res) => {
    const { guildId, soundId } = req.params;
    const userId = req.user!.userId;

    // Must be in a voice channel in this guild
    const state = await voiceService.getVoiceState(userId);
    if (!state || state.guildId !== guildId) {
      return res.status(400).json({ code: 'NOT_IN_VOICE', message: 'Not in a voice channel in this guild' });
    }

    const sound = await voiceService.getSound(soundId);
    if (!sound || sound.guildId !== guildId || !sound.available) {
      return res.status(404).json({ code: 'NOT_FOUND' });
    }

    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILD_VOICE_STATES,
      'SOUNDBOARD_PLAY',
      {
        guildId,
        channelId: state.channelId,
        soundId,
        userId,
        volume: sound.volume,
      } as any,
    );

    res.status(204).send();
  });

  // ── Voice Messages ──────────────────────────────────────────────────────

  /**
   * POST /channels/:channelId/voice-messages
   * Upload an audio blob and create a voice message (type 5).
   */
  router.post(
    '/channels/:channelId/voice-messages',
    auth,
    voiceMessageUpload.single('audio'),
    async (req, res) => {
      const channelId = String(req.params['channelId']);
      const userId = req.user!.userId;

      if (!req.file) {
        return res.status(400).json({ code: 'NO_FILE', message: 'No audio file provided' });
      }

      // Verify channel access
      const channel = await channelsService.getChannel(channelId);
      if (!channel) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Channel not found' });
      }
      if (channel.guildId) {
        const isMember = await guildsService.isMember(channel.guildId, userId);
        if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });
        const canAccess = await channelsService.canAccessChannel(channelId, userId);
        if (!canAccess) return res.status(403).json({ code: 'FORBIDDEN' });
      }

      // Parse optional voice metadata from multipart body fields
      const durationSecs = req.body.duration_secs != null
        ? parseInt(req.body.duration_secs, 10)
        : undefined;
      const waveform: string | undefined = req.body.waveform ?? undefined;

      // Upload the audio file to object storage
      let uploadResult;
      try {
        uploadResult = await filesService.uploadFile(
          req.file,
          {
            purpose: 'upload',
            contextId: channelId,
            spoiler: false,
            isVoiceMessage: true,
            durationSecs: !isNaN(durationSecs as number) ? (durationSecs as number) : undefined,
            waveform,
          },
          userId,
        );
      } catch (err: any) {
        if (err.code === 'FILE_TOO_LARGE') {
          return res.status(413).json({ code: 'FILE_TOO_LARGE', message: 'Audio file exceeds 10 MB limit' });
        }
        if (err.code === 'INVALID_FILE_TYPE') {
          return res.status(415).json({ code: 'INVALID_FILE_TYPE', message: err.message });
        }
        throw err;
      }

      const messageId = generateId();
      const MESSAGE_TYPE_VOICE = 5;
      const IS_VOICE_MESSAGE_FLAG = 1 << 13;

      // Insert message + attachment in a transaction
      const [created] = await ctx.db.transaction(async (tx) => {
        const [msg] = await tx
          .insert(messages)
          .values({
            id: messageId,
            channelId,
            guildId: channel.guildId ?? null,
            authorId: userId,
            content: '',
            type: MESSAGE_TYPE_VOICE,
            flags: IS_VOICE_MESSAGE_FLAG,
            mentions: [] as unknown as string[],
            mentionRoles: [] as unknown as string[],
            mentionEveryone: false,
            stickerIds: [] as unknown as string[],
          })
          .returning();

        await tx.update(channels).set({ lastMessageId: messageId }).where(eq(channels.id, channelId));

        await tx.insert(messageAttachments).values({
          id: uploadResult.id,
          messageId,
          filename: uploadResult.filename,
          description: null,
          contentType: uploadResult.contentType,
          size: uploadResult.size,
          url: uploadResult.url,
          proxyUrl: uploadResult.url,
          height: uploadResult.height,
          width: uploadResult.width,
          durationSecs: uploadResult.durationSecs ?? null,
          waveform: uploadResult.waveform ?? null,
          flags: 2, // bit 1 = voice message
        });

        return [msg];
      });

      const hydratedMessage = await messagesService.getMessage(messageId);

      // Broadcast via Socket.IO
      if (channel.guildId) {
        await emitRoomWithIntent(
          ctx.io,
          `guild:${channel.guildId}`,
          GatewayIntents.GUILD_MESSAGES,
          'MESSAGE_CREATE',
          hydratedMessage as any,
        );
      } else {
        await emitRoomWithIntent(
          ctx.io,
          `channel:${channelId}`,
          GatewayIntents.DIRECT_MESSAGES,
          'MESSAGE_CREATE',
          hydratedMessage as any,
        );
      }

      await ctx.redis.publish(
        `channel:${channelId}:messages`,
        JSON.stringify({ type: 'MESSAGE_CREATE', data: hydratedMessage }),
      );

      return res.status(201).json(hydratedMessage);
    },
  );

  /**
   * GET /channels/:channelId/voice-messages
   * List voice messages (type 5) for a channel.
   */
  router.get('/channels/:channelId/voice-messages', auth, async (req, res) => {
    const channelId = String(req.params['channelId']);
    const userId = req.user!.userId;

    const channel = await channelsService.getChannel(channelId);
    if (!channel) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Channel not found' });
    }
    if (channel.guildId) {
      const isMember = await guildsService.isMember(channel.guildId, userId);
      if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });
      const canAccess = await channelsService.canAccessChannel(channelId, userId);
      if (!canAccess) return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 100);
    const before: string | undefined = req.query['before'] ? String(req.query['before']) : undefined;

    const MESSAGE_TYPE_VOICE = 5;

    const baseCondition = and(
      eq(messages.channelId, channelId),
      eq(messages.type, MESSAGE_TYPE_VOICE),
      sql`${messages.deletedAt} IS NULL`,
    );

    const rows = await ctx.db
      .select()
      .from(messages)
      .where(
        before
          ? and(baseCondition, sql`${messages.id} < ${before}`)
          : baseCondition,
      )
      .orderBy(desc(messages.id))
      .limit(limit);

    // Hydrate each message (attachments, author info, etc.)
    const hydrated = await Promise.all(rows.map((m) => messagesService.getMessage(m.id)));
    return res.json(hydrated.filter(Boolean));
  });

  /**
   * DELETE /channels/:channelId/voice-messages/:messageId
   * Delete a voice message (owner or guild owner only).
   */
  router.delete('/channels/:channelId/voice-messages/:messageId', auth, async (req, res) => {
    const channelId = String(req.params['channelId']);
    const messageId = String(req.params['messageId']);
    const userId = req.user!.userId;

    const channel = await channelsService.getChannel(channelId);
    if (!channel) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Channel not found' });
    }
    if (channel.guildId) {
      const isMember = await guildsService.isMember(channel.guildId, userId);
      if (!isMember) return res.status(403).json({ code: 'FORBIDDEN' });
    }

    let isAdmin = false;
    if (channel.guildId) {
      const guild = await guildsService.getGuild(channel.guildId);
      isAdmin = guild?.ownerId === userId;
    }

    const result = await messagesService.deleteMessage(messageId, userId, isAdmin);
    if (!result) return res.status(404).json({ code: 'NOT_FOUND' });
    if (typeof result === 'object' && 'error' in result) {
      return res.status(403).json({ code: result.error });
    }

    const deleteEvent = {
      id: messageId,
      channelId,
      guildId: channel.guildId ?? undefined,
    };

    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILD_MESSAGES,
        'MESSAGE_DELETE',
        deleteEvent,
      );
    } else {
      await emitRoomWithIntent(
        ctx.io,
        `channel:${channelId}`,
        GatewayIntents.DIRECT_MESSAGES,
        'MESSAGE_DELETE',
        deleteEvent,
      );
    }

    return res.status(204).send();
  });

  return router;
}
