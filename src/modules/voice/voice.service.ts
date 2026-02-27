import { eq, and } from 'drizzle-orm';
import { AccessToken } from 'livekit-server-sdk';
import { voiceStates, stageInstances, soundboardSounds, channels } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import type {
  JoinVoiceInput,
  UpdateVoiceStateInput,
  ModifyMemberVoiceStateInput,
  CreateStageInstanceInput,
  UpdateStageInstanceInput,
  CreateSoundboardSoundInput,
  UpdateSoundboardSoundInput,
  StartScreenShareInput,
} from './voice.schemas.js';

export function createVoiceService(ctx: AppContext) {
  // ── LiveKit Token Generation ──────────────────────────────────────────

  async function generateJoinToken(
    userId: string,
    username: string,
    channelId: string,
    guildId: string | null,
  ): Promise<string> {
    const roomName = `voice_${channelId}`;

    const token = new AccessToken(ctx.env.LIVEKIT_API_KEY, ctx.env.LIVEKIT_API_SECRET, {
      identity: userId,
      name: username,
      metadata: JSON.stringify({ guildId }),
    });

    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return await token.toJwt();
  }

  // ── LiveKit Room Management ───────────────────────────────────────────

  async function ensureRoomExists(channelId: string): Promise<string> {
    const roomName = `voice_${channelId}`;

    const existing = await ctx.redis.get(`voice:room:${channelId}`);
    if (existing) return roomName;

    try {
      await ctx.livekit.createRoom({
        name: roomName,
        emptyTimeout: 300, // 5 min empty timeout
        maxParticipants: 50,
      });
    } catch (err: any) {
      // Room may already exist — that's fine
      if (!err.message?.includes('already exists')) {
        logger.warn({ err, channelId }, 'LiveKit room creation error (may be non-fatal)');
      }
    }

    await ctx.redis.set(`voice:room:${channelId}`, roomName);
    return roomName;
  }

  async function deleteRoomIfEmpty(channelId: string): Promise<void> {
    const members = await ctx.redis.scard(`voice:channel:${channelId}`);
    if (members === 0) {
      const roomName = `voice_${channelId}`;
      try {
        await ctx.livekit.deleteRoom(roomName);
      } catch {
        // Room may already be gone
      }
      await ctx.redis.del(`voice:room:${channelId}`);
    }
  }

  // ── Voice State Management ────────────────────────────────────────────

  async function joinChannel(
    userId: string,
    username: string,
    channelId: string,
    guildId: string | null,
    sessionId: string,
    input: JoinVoiceInput,
  ) {
    // Check if user is already in a different voice channel
    const currentChannel = await ctx.redis.hget(`voice:user:${userId}`, 'channelId');
    if (currentChannel && currentChannel !== channelId) {
      await leaveChannel(userId);
    }

    // Check if this is a stage channel (audience joins suppressed)
    const [channel] = await ctx.db
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    const isStageChannel = channel?.type === 'GUILD_STAGE_VOICE';

    // Ensure LiveKit room exists
    await ensureRoomExists(channelId);

    // Generate LiveKit token
    const token = await generateJoinToken(userId, username, channelId, guildId);

    // Upsert voice state in DB (userId is PK — one channel at a time)
    await ctx.db
      .insert(voiceStates)
      .values({
        userId,
        channelId,
        guildId,
        sessionId,
        selfMute: input.selfMute,
        selfDeaf: input.selfDeaf,
        suppress: isStageChannel,
      })
      .onConflictDoUpdate({
        target: voiceStates.userId,
        set: {
          channelId,
          guildId,
          sessionId,
          selfMute: input.selfMute,
          selfDeaf: input.selfDeaf,
          selfStream: false,
          selfVideo: false,
          suppress: isStageChannel,
          joinedAt: new Date(),
        },
      });

    // Update Redis presence
    await ctx.redis.sadd(`voice:channel:${channelId}`, userId);
    await ctx.redis.hset(`voice:user:${userId}`, {
      channelId,
      guildId: guildId ?? '',
      sessionId,
    });
    await ctx.redis.expire(`voice:user:${userId}`, 3600);

    if (guildId) {
      await ctx.redis.sadd(`voice:guild:${guildId}:channels`, channelId);
    }

    logger.info({ userId, channelId, guildId }, 'User joined voice channel');

    const voiceState = {
      userId,
      channelId,
      guildId,
      sessionId,
      deaf: false,
      mute: false,
      selfDeaf: input.selfDeaf,
      selfMute: input.selfMute,
      selfStream: false,
      selfVideo: false,
      suppress: isStageChannel,
      requestToSpeakTimestamp: null,
    };

    return { token, voiceState };
  }

  async function leaveChannel(userId: string) {
    // Look up current channel from Redis (fast path)
    const userData = await ctx.redis.hgetall(`voice:user:${userId}`);
    if (!userData.channelId) return null;

    const { channelId, guildId } = userData;

    // Remove from DB
    await ctx.db.delete(voiceStates).where(eq(voiceStates.userId, userId));

    // Remove from Redis
    await ctx.redis.srem(`voice:channel:${channelId}`, userId);
    await ctx.redis.del(`voice:user:${userId}`);
    await ctx.redis.del(`voice:screenshare:${channelId}:${userId}`);

    // Check if channel is now empty
    const remaining = await ctx.redis.scard(`voice:channel:${channelId}`);
    if (remaining === 0) {
      if (guildId) {
        await ctx.redis.srem(`voice:guild:${guildId}:channels`, channelId);
      }
      await deleteRoomIfEmpty(channelId);
    }

    logger.info({ userId, channelId }, 'User left voice channel');

    return {
      userId,
      channelId: null as string | null,
      guildId: guildId || null,
      sessionId: '',
      deaf: false,
      mute: false,
      selfDeaf: false,
      selfMute: false,
      selfStream: false,
      selfVideo: false,
      suppress: false,
      requestToSpeakTimestamp: null,
    };
  }

  async function updateVoiceState(userId: string, input: UpdateVoiceStateInput) {
    const updates: Record<string, unknown> = {};
    if (input.selfMute !== undefined) updates.selfMute = input.selfMute;
    if (input.selfDeaf !== undefined) updates.selfDeaf = input.selfDeaf;
    if (input.selfVideo !== undefined) updates.selfVideo = input.selfVideo;
    if (input.selfStream !== undefined) updates.selfStream = input.selfStream;

    // selfDeaf implies selfMute (Discord behavior)
    if (input.selfDeaf === true) updates.selfMute = true;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(voiceStates)
      .set(updates)
      .where(eq(voiceStates.userId, userId))
      .returning();

    return updated ?? null;
  }

  async function modifyMemberVoiceState(targetUserId: string, input: ModifyMemberVoiceStateInput) {
    const updates: Record<string, unknown> = {};
    if (input.mute !== undefined) updates.mute = input.mute;
    if (input.deaf !== undefined) updates.deaf = input.deaf;
    if (input.suppress !== undefined) updates.suppress = input.suppress;

    // Server-deaf implies server-mute
    if (input.deaf === true) updates.mute = true;

    // Disconnect the user
    if (input.channelId === null) {
      return leaveChannel(targetUserId);
    }

    // Move to different channel
    if (input.channelId !== undefined) {
      updates.channelId = input.channelId;
    }

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(voiceStates)
      .set(updates)
      .where(eq(voiceStates.userId, targetUserId))
      .returning();

    return updated ?? null;
  }

  async function getVoiceState(userId: string) {
    const [state] = await ctx.db
      .select()
      .from(voiceStates)
      .where(eq(voiceStates.userId, userId))
      .limit(1);
    return state ?? null;
  }

  async function getChannelVoiceStates(channelId: string) {
    return ctx.db.select().from(voiceStates).where(eq(voiceStates.channelId, channelId));
  }

  async function getGuildVoiceStates(guildId: string) {
    return ctx.db.select().from(voiceStates).where(eq(voiceStates.guildId, guildId));
  }

  // ── Screen Share ──────────────────────────────────────────────────────

  async function startScreenShare(userId: string, channelId: string, input: StartScreenShareInput) {
    await ctx.db
      .update(voiceStates)
      .set({ selfStream: true })
      .where(eq(voiceStates.userId, userId));

    await ctx.redis.hset(`voice:screenshare:${channelId}:${userId}`, {
      quality: input.quality,
      shareType: input.shareType,
      audioEnabled: input.audioEnabled ? 'true' : 'false',
      startedAt: new Date().toISOString(),
    });
    await ctx.redis.expire(`voice:screenshare:${channelId}:${userId}`, 3600);

    return {
      userId,
      channelId,
      quality: input.quality,
      shareType: input.shareType,
      audioEnabled: input.audioEnabled,
      viewerCount: 0,
      startedAt: new Date().toISOString(),
    };
  }

  async function stopScreenShare(userId: string, channelId: string) {
    await ctx.db
      .update(voiceStates)
      .set({ selfStream: false })
      .where(eq(voiceStates.userId, userId));

    await ctx.redis.del(`voice:screenshare:${channelId}:${userId}`);
  }

  // ── Stage Instances ───────────────────────────────────────────────────

  async function createStageInstance(guildId: string, input: CreateStageInstanceInput) {
    const stageId = generateId();
    const [stage] = await ctx.db
      .insert(stageInstances)
      .values({
        id: stageId,
        guildId,
        channelId: input.channelId,
        topic: input.topic,
        privacyLevel: input.privacyLevel,
      })
      .returning();

    return stage;
  }

  async function getStageInstance(channelId: string) {
    const [stage] = await ctx.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.channelId, channelId))
      .limit(1);
    return stage ?? null;
  }

  async function getStageInstanceById(stageId: string) {
    const [stage] = await ctx.db
      .select()
      .from(stageInstances)
      .where(eq(stageInstances.id, stageId))
      .limit(1);
    return stage ?? null;
  }

  async function getGuildStageInstances(guildId: string) {
    return ctx.db.select().from(stageInstances).where(eq(stageInstances.guildId, guildId));
  }

  async function updateStageInstance(stageId: string, input: UpdateStageInstanceInput) {
    const updates: Record<string, unknown> = {};
    if (input.topic !== undefined) updates.topic = input.topic;
    if (input.privacyLevel !== undefined) updates.privacyLevel = input.privacyLevel;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(stageInstances)
      .set(updates)
      .where(eq(stageInstances.id, stageId))
      .returning();

    return updated ?? null;
  }

  async function deleteStageInstance(stageId: string) {
    await ctx.db.delete(stageInstances).where(eq(stageInstances.id, stageId));
  }

  async function requestToSpeak(userId: string) {
    const [updated] = await ctx.db
      .update(voiceStates)
      .set({ requestToSpeakTimestamp: new Date() })
      .where(eq(voiceStates.userId, userId))
      .returning();
    return updated ?? null;
  }

  async function approveSpeaker(userId: string) {
    const [updated] = await ctx.db
      .update(voiceStates)
      .set({ suppress: false, requestToSpeakTimestamp: null })
      .where(eq(voiceStates.userId, userId))
      .returning();
    return updated ?? null;
  }

  async function revokeSpeaker(userId: string) {
    const [updated] = await ctx.db
      .update(voiceStates)
      .set({ suppress: true, requestToSpeakTimestamp: null })
      .where(eq(voiceStates.userId, userId))
      .returning();
    return updated ?? null;
  }

  // ── Soundboard ────────────────────────────────────────────────────────

  async function createSound(guildId: string, uploaderId: string, input: CreateSoundboardSoundInput) {
    const soundId = generateId();
    const [sound] = await ctx.db
      .insert(soundboardSounds)
      .values({
        id: soundId,
        guildId,
        name: input.name,
        soundHash: input.soundHash,
        volume: input.volume,
        emojiId: input.emojiId ?? null,
        emojiName: input.emojiName ?? null,
        uploaderId,
      })
      .returning();

    return sound;
  }

  async function getGuildSounds(guildId: string) {
    return ctx.db
      .select()
      .from(soundboardSounds)
      .where(and(eq(soundboardSounds.guildId, guildId), eq(soundboardSounds.available, true)));
  }

  async function getSound(soundId: string) {
    const [sound] = await ctx.db
      .select()
      .from(soundboardSounds)
      .where(eq(soundboardSounds.id, soundId))
      .limit(1);
    return sound ?? null;
  }

  async function updateSound(soundId: string, input: UpdateSoundboardSoundInput) {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.volume !== undefined) updates.volume = input.volume;
    if (input.emojiId !== undefined) updates.emojiId = input.emojiId;
    if (input.emojiName !== undefined) updates.emojiName = input.emojiName;
    if (input.available !== undefined) updates.available = input.available;

    if (Object.keys(updates).length === 0) return null;

    const [updated] = await ctx.db
      .update(soundboardSounds)
      .set(updates)
      .where(eq(soundboardSounds.id, soundId))
      .returning();

    return updated ?? null;
  }

  async function deleteSound(soundId: string) {
    await ctx.db.delete(soundboardSounds).where(eq(soundboardSounds.id, soundId));
  }

  return {
    generateJoinToken,
    ensureRoomExists,
    deleteRoomIfEmpty,
    joinChannel,
    leaveChannel,
    updateVoiceState,
    modifyMemberVoiceState,
    getVoiceState,
    getChannelVoiceStates,
    getGuildVoiceStates,
    startScreenShare,
    stopScreenShare,
    createStageInstance,
    getStageInstance,
    getStageInstanceById,
    getGuildStageInstances,
    updateStageInstance,
    deleteStageInstance,
    requestToSpeak,
    approveSpeaker,
    revokeSpeaker,
    createSound,
    getGuildSounds,
    getSound,
    updateSound,
    deleteSound,
  };
}

export type VoiceService = ReturnType<typeof createVoiceService>;
