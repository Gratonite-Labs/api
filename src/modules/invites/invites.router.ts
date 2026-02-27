import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../lib/context.js';
import { requireAuth } from '../../middleware/auth.js';
import { createInvitesService } from './invites.service.js';
import { createGuildsService } from '../guilds/guilds.service.js';
import { GatewayIntents, emitRoomWithIntent } from '../../lib/gateway-intents.js';

const createInviteSchema = z.object({
  channelId: z.string(),
  maxUses: z.number().int().min(0).max(100).optional(),
  maxAgeSeconds: z.number().int().min(0).max(604800).optional(), // max 7 days
  temporary: z.boolean().optional(),
});

export function invitesRouter(ctx: AppContext): Router {
  const router = Router();
  const invitesService = createInvitesService(ctx);
  const guildsService = createGuildsService(ctx);
  const auth = requireAuth(ctx);

  // Get invite info (public, no auth required for viewing)
  router.get('/:code', async (req, res) => {
    const invite = await invitesService.getInvite(req.params.code);
    if (!invite) return res.status(404).json({ code: 'NOT_FOUND', message: 'Invite not found or expired' });

    const guild = await guildsService.getGuild(invite.guildId);

    res.json({
      code: invite.code,
      guild: guild
        ? {
            id: guild.id,
            name: guild.name,
            iconHash: guild.iconHash,
            memberCount: guild.memberCount,
            description: guild.description,
          }
        : null,
      channelId: invite.channelId,
      inviterId: invite.inviterId,
      uses: invite.uses,
      maxUses: invite.maxUses,
      expiresAt: invite.expiresAt,
    });
  });

  // Accept invite (join guild)
  router.post('/:code', auth, async (req, res) => {
    const userId = req.user!.userId;
    const invite = await invitesService.useInvite(req.params.code);

    if (!invite) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Invite not found, expired, or max uses reached' });
    }

    // Check if already a member
    if (await guildsService.isMember(invite.guildId, userId)) {
      return res.status(400).json({ code: 'ALREADY_MEMBER', message: 'You are already a member of this server' });
    }

    // Check if banned
    if (await guildsService.isBanned(invite.guildId, userId)) {
      return res.status(403).json({ code: 'BANNED', message: 'You are banned from this server' });
    }

    await guildsService.addMember(invite.guildId, userId);

    const guild = await guildsService.getGuild(invite.guildId);

    await emitRoomWithIntent(
      ctx.io,
      `guild:${invite.guildId}`,
      GatewayIntents.GUILD_MEMBERS,
      'GUILD_MEMBER_ADD',
      {
        userId: userId,
        guildId: invite.guildId,
      } as any,
    );

    res.json(guild);
  });

  // Create invite for a guild
  router.post('/guilds/:guildId/invites', auth, async (req, res) => {
    const guildId = req.params.guildId;
    const userId = req.user!.userId;

    if (!await guildsService.isMember(guildId, userId)) {
      return res.status(403).json({ code: 'NOT_A_MEMBER' });
    }

    // TODO: Check CREATE_INVITE permission

    const parsed = createInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', errors: parsed.error.flatten().fieldErrors });
    }

    const invite = await invitesService.createInvite({
      guildId,
      channelId: parsed.data.channelId,
      inviterId: userId,
      maxUses: parsed.data.maxUses,
      maxAgeSeconds: parsed.data.maxAgeSeconds,
      temporary: parsed.data.temporary,
    });

    res.status(201).json(invite);
  });

  // List guild invites
  router.get('/guilds/:guildId/invites', auth, async (req, res) => {
    const guildId = req.params.guildId;

    // TODO: Check MANAGE_GUILD permission
    const guild = await guildsService.getGuild(guildId);
    if (!guild || guild.ownerId !== req.user!.userId) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    const guildInvites = await invitesService.getGuildInvites(guildId);
    res.json(guildInvites);
  });

  // Delete invite
  router.delete('/:code', auth, async (req, res) => {
    const invite = await invitesService.getInvite(req.params.code);
    if (!invite) return res.status(404).json({ code: 'NOT_FOUND' });

    // Only invite creator or guild owner can delete
    const guild = await guildsService.getGuild(invite.guildId);
    if (
      invite.inviterId !== req.user!.userId &&
      guild?.ownerId !== req.user!.userId
    ) {
      return res.status(403).json({ code: 'FORBIDDEN' });
    }

    await invitesService.deleteInvite(req.params.code);
    res.status(204).send();
  });

  return router;
}
