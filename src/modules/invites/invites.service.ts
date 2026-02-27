import { eq, and, sql } from 'drizzle-orm';
import { invites } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { randomBytes } from 'crypto';

export function createInvitesService(ctx: AppContext) {
  function generateInviteCode(length = 8): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(length);
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars[bytes[i] % chars.length];
    }
    return code;
  }

  async function createInvite(data: {
    guildId: string;
    channelId: string;
    inviterId: string;
    maxUses?: number;
    maxAgeSeconds?: number;
    temporary?: boolean;
  }) {
    const code = generateInviteCode();

    const expiresAt = data.maxAgeSeconds
      ? new Date(Date.now() + data.maxAgeSeconds * 1000)
      : null;

    const [invite] = await ctx.db
      .insert(invites)
      .values({
        code,
        guildId: data.guildId,
        channelId: data.channelId,
        inviterId: data.inviterId,
        maxUses: data.maxUses ?? null,
        maxAgeSeconds: data.maxAgeSeconds ?? null,
        temporary: data.temporary ?? false,
        expiresAt,
      })
      .returning();

    return invite;
  }

  async function getInvite(code: string) {
    const [invite] = await ctx.db
      .select()
      .from(invites)
      .where(eq(invites.code, code))
      .limit(1);

    if (!invite) return null;

    // Check expiration
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
      await ctx.db.delete(invites).where(eq(invites.code, code));
      return null;
    }

    return invite;
  }

  async function getGuildInvites(guildId: string) {
    return ctx.db
      .select()
      .from(invites)
      .where(eq(invites.guildId, guildId));
  }

  async function useInvite(code: string) {
    const invite = await getInvite(code);
    if (!invite) return null;

    // Check max uses
    if (invite.maxUses && invite.uses >= invite.maxUses) {
      await ctx.db.delete(invites).where(eq(invites.code, code));
      return null;
    }

    // Increment use count
    await ctx.db
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1` })
      .where(eq(invites.code, code));

    // Delete if max uses reached
    if (invite.maxUses && invite.uses + 1 >= invite.maxUses) {
      await ctx.db.delete(invites).where(eq(invites.code, code));
    }

    return invite;
  }

  async function deleteInvite(code: string) {
    await ctx.db.delete(invites).where(eq(invites.code, code));
  }

  return {
    createInvite,
    getInvite,
    getGuildInvites,
    useInvite,
    deleteInvite,
  };
}

export type InvitesService = ReturnType<typeof createInvitesService>;
