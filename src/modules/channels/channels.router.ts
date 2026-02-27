import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createChannelsService } from './channels.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { createChannelSchema, updateChannelSchema, reorderChannelsSchema } from './channels.schemas.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';
import { PermissionFlags } from '@gratonite/types';

export function channelsRouter(ctx: AppContext): Router {
  const router = Router();
  const channelsService = createChannelsService(ctx);
  const guildsService = createGuildsService(ctx);
  const auth = requireAuth(ctx);

  // ── Guild channel routes (nested under /guilds/:guildId/channels) ──────

  // Get all channels for a guild
  router.get('/guilds/:guildId/channels', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const userId = req.user!.userId;
    if (!await guildsService.isMember(guildId, userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const guildChannels = await channelsService.getGuildChannels(guildId);
    const visible = await Promise.all(
      guildChannels.map(async (channel) => {
        const allowed = await channelsService.canAccessChannel(channel.id, userId);
        return allowed ? channel : null;
      }),
    );

    // Compute isPrivate for each visible channel by checking if @everyone
    // has VIEW_CHANNEL denied in permission overrides
    const visibleChannels = visible.filter((channel) => channel !== null);
    const roles = await guildsService.getRoles(guildId);
    const everyoneRole = roles.find((r: any) => r.name === '@everyone');

    const enriched = await Promise.all(
      visibleChannels.map(async (channel) => {
        let isPrivate = false;
        if (everyoneRole) {
          const overrides = await channelsService.getPermissionOverrides(channel.id);
          const everyoneOverride = overrides.find(
            (o: any) => o.targetType === 'role' && o.targetId === everyoneRole.id,
          );
          if (everyoneOverride) {
            isPrivate = (BigInt(everyoneOverride.deny) & PermissionFlags.VIEW_CHANNEL) !== 0n;
          }
        }
        return { ...channel, isPrivate };
      }),
    );

    res.json(enriched);
  });

  // Create channel in guild
  router.post('/guilds/:guildId/channels', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    // TODO: Check MANAGE_CHANNELS permission
    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = createChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const channel = await channelsService.createChannel(guildId, parsed.data);
    await emitRoomWithIntent(
      ctx.io,
      `guild:${guildId}`,
      GatewayIntents.GUILDS,
      'CHANNEL_CREATE',
      channel as any,
    );

    res.status(201).json(channel);
  });

  // Reorder channels in guild
  router.patch('/guilds/:guildId/channels', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = await guildsService.getGuild(guildId);
    if (!guild) return res.status(404).json({ code: 'NOT_FOUND' });

    if (guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const parsed = reorderChannelsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    await channelsService.reorderChannels(guildId, parsed.data.channels);
    res.status(204).send();
  });

  // ── Individual channel routes ──────────────────────────────────────────

  // Get channel
  router.get('/channels/:channelId', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ code: 'NOT_FOUND' });

    if (channel.guildId) {
      if (!await guildsService.isMember(channel.guildId, req.user!.userId)) {
        return res.status(403).json({ code: 'NOT_A_MEMBER' });
      }

      if (!await channelsService.canAccessChannel(channel.id, req.user!.userId)) {
        return res.status(403).json({ code: 'FORBIDDEN' });
      }
    }

    res.json(channel);
  });

  // Update channel
  router.patch('/channels/:channelId', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ code: 'NOT_FOUND' });

    if (channel.guildId) {
      const guild = await guildsService.getGuild(channel.guildId);
      if (!guild || guild.ownerId !== req.user!.userId) {
        return res.status(403).json({ code: 'FORBIDDEN' });
      }
    }

    const parsed = updateChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const updated = await channelsService.updateChannel(req.params.channelId, parsed.data);
    if (updated && channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILDS,
        'CHANNEL_UPDATE',
        updated as any,
      );
    }

    res.json(updated);
  });

  // Delete channel
  router.delete('/channels/:channelId', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ code: 'NOT_FOUND' });

    if (channel.guildId) {
      const guild = await guildsService.getGuild(channel.guildId);
      if (!guild || guild.ownerId !== req.user!.userId) {
        return res.status(403).json({ code: 'FORBIDDEN' });
      }
    }

    await channelsService.deleteChannel(req.params.channelId);

    if (channel.guildId) {
      await emitRoomWithIntent(
        ctx.io,
        `guild:${channel.guildId}`,
        GatewayIntents.GUILDS,
        'CHANNEL_DELETE',
        {
          id: req.params.channelId,
          guildId: String(channel.guildId),
        },
      );
    }

    res.status(204).send();
  });

  // ── Permission overrides ─────────────────────────────────────────────────

  // Get permission overrides for a channel
  router.get('/channels/:channelId/permissions', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ code: 'NOT_FOUND' });
    if (channel.guildId && !await guildsService.isMember(channel.guildId, req.user!.userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    const overrides = await channelsService.getPermissionOverrides(req.params.channelId);
    res.json(overrides);
  });

  // Set permission override
  router.put('/channels/:channelId/permissions/:targetId', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel || !channel.guildId) return res.status(404).json({ code: 'NOT_FOUND' });

    const guild = await guildsService.getGuild(channel.guildId);
    if (!guild || guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const { type, allow, deny } = req.body;
    if (!type || !['role', 'user'].includes(type)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'type must be "role" or "user"' });
    }

    const override = await channelsService.setPermissionOverride(
      req.params.channelId,
      req.params.targetId,
      type,
      allow ?? '0',
      deny ?? '0',
    );

    res.json(override);
  });

  // Delete permission override
  router.delete('/channels/:channelId/permissions/:targetId', auth, async (req, res) => {
    const channel = await channelsService.getChannel(req.params.channelId);
    if (!channel || !channel.guildId) return res.status(404).json({ code: 'NOT_FOUND' });

    const guild = await guildsService.getGuild(channel.guildId);
    if (!guild || guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await channelsService.deletePermissionOverride(
      req.params.channelId,
      req.params.targetId,
    );

    res.status(204).send();
  });

  return router;
}
