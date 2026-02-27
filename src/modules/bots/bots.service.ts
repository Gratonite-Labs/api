import { and, eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import {
  oauth2Apps,
  oauth2Codes,
  oauth2Tokens,
  bots,
  slashCommands,
  users,
  userProfiles,
} from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import type {
  AuthorizeInput,
  CreateAppInput,
  CreateSlashCommandInput,
  TokenInput,
  UpdateAppInput,
  UpdateSlashCommandInput,
} from './bots.schemas.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function generateSecret() {
  return randomBytes(32).toString('hex');
}

function normalizeUsername(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24);
}

export function createBotsService(ctx: AppContext) {
  async function createApp(ownerId: string, input: CreateAppInput) {
    const appId = generateId();
    const clientSecret = generateSecret();
    const clientSecretHash = hashToken(clientSecret);

    const [app] = await ctx.db
      .insert(oauth2Apps)
      .values({
        id: appId,
        ownerId,
        name: input.name,
        description: input.description ?? null,
        clientSecretHash,
        redirectUris: input.redirectUris,
        botPublic: input.botPublic ?? true,
        botRequireCodeGrant: input.botRequireCodeGrant ?? true,
        termsUrl: input.termsUrl ?? null,
        privacyUrl: input.privacyUrl ?? null,
      })
      .returning();

    return { app, clientSecret };
  }

  async function listApps(ownerId: string) {
    return ctx.db
      .select()
      .from(oauth2Apps)
      .where(eq(oauth2Apps.ownerId, ownerId));
  }

  async function getApp(appId: string) {
    const [app] = await ctx.db
      .select()
      .from(oauth2Apps)
      .where(eq(oauth2Apps.id, appId))
      .limit(1);
    return app ?? null;
  }

  async function updateApp(appId: string, ownerId: string, input: UpdateAppInput) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.redirectUris !== undefined) updates.redirectUris = input.redirectUris;
    if (input.botPublic !== undefined) updates.botPublic = input.botPublic;
    if (input.botRequireCodeGrant !== undefined) updates.botRequireCodeGrant = input.botRequireCodeGrant;
    if (input.termsUrl !== undefined) updates.termsUrl = input.termsUrl;
    if (input.privacyUrl !== undefined) updates.privacyUrl = input.privacyUrl;

    const [updated] = await ctx.db
      .update(oauth2Apps)
      .set(updates)
      .where(and(eq(oauth2Apps.id, appId), eq(oauth2Apps.ownerId, ownerId)))
      .returning();
    return updated ?? null;
  }

  async function deleteApp(appId: string, ownerId: string) {
    const [deleted] = await ctx.db
      .delete(oauth2Apps)
      .where(and(eq(oauth2Apps.id, appId), eq(oauth2Apps.ownerId, ownerId)))
      .returning();
    return deleted ?? null;
  }

  async function resetSecret(appId: string, ownerId: string) {
    const newSecret = generateSecret();
    const [updated] = await ctx.db
      .update(oauth2Apps)
      .set({ clientSecretHash: hashToken(newSecret), updatedAt: new Date() })
      .where(and(eq(oauth2Apps.id, appId), eq(oauth2Apps.ownerId, ownerId)))
      .returning();
    if (!updated) return null;
    return { app: updated, clientSecret: newSecret };
  }

  async function authorize(userId: string, input: AuthorizeInput) {
    const app = await getApp(input.clientId);
    if (!app) return { error: 'INVALID_CLIENT' as const };

    const redirectUris = Array.isArray(app.redirectUris) ? app.redirectUris : [];
    if (!redirectUris.includes(input.redirectUri)) {
      return { error: 'INVALID_REDIRECT_URI' as const };
    }

    const code = generateSecret();
    const scopes = input.scope ? input.scope.split(' ').filter(Boolean) : [];
    await ctx.db.insert(oauth2Codes).values({
      code,
      applicationId: app.id,
      userId,
      redirectUri: input.redirectUri,
      scopes,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

    return { code };
  }

  async function exchangeToken(input: TokenInput) {
    const app = await getApp(input.clientId);
    if (!app) return { error: 'INVALID_CLIENT' as const };

    if (hashToken(input.clientSecret) !== app.clientSecretHash) {
      return { error: 'INVALID_CLIENT_SECRET' as const };
    }

    const [codeRow] = await ctx.db
      .select()
      .from(oauth2Codes)
      .where(eq(oauth2Codes.code, input.code))
      .limit(1);
    if (!codeRow) return { error: 'INVALID_CODE' as const };
    if (codeRow.applicationId !== app.id) return { error: 'INVALID_CODE' as const };
    if (codeRow.redirectUri !== input.redirectUri) return { error: 'INVALID_REDIRECT_URI' as const };
    if (codeRow.expiresAt.getTime() < Date.now()) return { error: 'CODE_EXPIRED' as const };

    await ctx.db.delete(oauth2Codes).where(eq(oauth2Codes.code, input.code));

    const accessToken = generateSecret();
    const refreshToken = generateSecret();

    await ctx.db.insert(oauth2Tokens).values({
      id: generateId(),
      applicationId: app.id,
      userId: codeRow.userId,
      tokenType: 'access',
      tokenHash: hashToken(accessToken),
      scopes: codeRow.scopes ?? [],
      expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
    });

    await ctx.db.insert(oauth2Tokens).values({
      id: generateId(),
      applicationId: app.id,
      userId: codeRow.userId,
      tokenType: 'refresh',
      tokenHash: hashToken(refreshToken),
      scopes: codeRow.scopes ?? [],
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
      scope: (codeRow.scopes ?? []).join(' '),
      tokenType: 'bearer',
    };
  }

  async function createBot(appId: string, ownerId: string) {
    const app = await getApp(appId);
    if (!app || app.ownerId !== ownerId) return { error: 'FORBIDDEN' as const };

    const [existing] = await ctx.db
      .select()
      .from(bots)
      .where(eq(bots.applicationId, appId))
      .limit(1);

    if (existing) {
      return { bot: existing, token: null };
    }

    const baseUsername = normalizeUsername(`${app.name}_bot`) || `bot_${appId.slice(-6)}`;
    let username = baseUsername;
    let attempts = 0;
    while (attempts < 5) {
      const [conflict] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      if (!conflict) break;
      attempts += 1;
      username = `${baseUsername}_${randomBytes(2).toString('hex')}`.slice(0, 32);
    }

    const botUserId = generateId();
    await ctx.db.insert(users).values({
      id: botUserId,
      username,
      email: `bot_${appId}@bots.gratonite.local`,
      emailVerified: true,
      bot: true,
      passwordHash: null,
      dateOfBirth: null,
    });

    await ctx.db.insert(userProfiles).values({
      userId: botUserId,
      displayName: app.name,
    });

    const token = generateSecret();
    const tokenHash = hashToken(token);

    const [bot] = await ctx.db
      .insert(bots)
      .values({
        applicationId: appId,
        userId: botUserId,
        tokenHash,
        public: app.botPublic,
      })
      .returning();

    await ctx.db.insert(oauth2Tokens).values({
      id: generateId(),
      applicationId: appId,
      userId: botUserId,
      tokenType: 'bot',
      tokenHash,
      scopes: [],
      expiresAt: null,
    });

    return { bot, token };
  }

  async function resetBotToken(appId: string, ownerId: string) {
    const app = await getApp(appId);
    if (!app || app.ownerId !== ownerId) return { error: 'FORBIDDEN' as const };

    const [existing] = await ctx.db
      .select()
      .from(bots)
      .where(eq(bots.applicationId, appId))
      .limit(1);
    if (!existing) return { error: 'BOT_NOT_FOUND' as const };

    const token = generateSecret();
    const tokenHash = hashToken(token);

    await ctx.db
      .update(bots)
      .set({ tokenHash })
      .where(eq(bots.applicationId, appId));

    await ctx.db.insert(oauth2Tokens).values({
      id: generateId(),
      applicationId: appId,
      userId: existing.userId,
      tokenType: 'bot',
      tokenHash,
      scopes: [],
      expiresAt: null,
    });

    return { token };
  }

  async function getBot(appId: string) {
    const [bot] = await ctx.db
      .select()
      .from(bots)
      .where(eq(bots.applicationId, appId))
      .limit(1);
    return bot ?? null;
  }

  async function verifyBotToken(token: string) {
    const tokenHash = hashToken(token);
    const [row] = await ctx.db
      .select()
      .from(oauth2Tokens)
      .where(and(eq(oauth2Tokens.tokenHash, tokenHash), eq(oauth2Tokens.tokenType, 'bot')))
      .limit(1);
    if (!row || row.revoked) return null;
    return row;
  }

  async function createSlashCommand(appId: string, ownerId: string, input: CreateSlashCommandInput) {
    const app = await getApp(appId);
    if (!app || app.ownerId !== ownerId) return null;

    const [command] = await ctx.db
      .insert(slashCommands)
      .values({
        id: generateId(),
        applicationId: appId,
        guildId: input.guildId ?? null,
        name: input.name,
        description: input.description,
        options: input.options ?? [],
        defaultMemberPermissions: input.defaultMemberPermissions ?? '0',
        dmPermission: input.dmPermission ?? true,
      })
      .returning();

    return command;
  }

  async function listSlashCommands(appId: string, ownerId: string) {
    const app = await getApp(appId);
    if (!app || app.ownerId !== ownerId) return null;

    return ctx.db
      .select()
      .from(slashCommands)
      .where(eq(slashCommands.applicationId, appId));
  }

  async function updateSlashCommand(
    appId: string,
    ownerId: string,
    commandId: string,
    input: UpdateSlashCommandInput,
  ) {
    const app = await getApp(appId);
    if (!app || app.ownerId !== ownerId) return null;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.options !== undefined) updates.options = input.options;
    if (input.defaultMemberPermissions !== undefined)
      updates.defaultMemberPermissions = input.defaultMemberPermissions;
    if (input.dmPermission !== undefined) updates.dmPermission = input.dmPermission;

    const [updated] = await ctx.db
      .update(slashCommands)
      .set(updates)
      .where(and(eq(slashCommands.id, commandId), eq(slashCommands.applicationId, appId)))
      .returning();
    return updated ?? null;
  }

  async function deleteSlashCommand(appId: string, ownerId: string, commandId: string) {
    const app = await getApp(appId);
    if (!app || app.ownerId !== ownerId) return null;

    const [deleted] = await ctx.db
      .delete(slashCommands)
      .where(and(eq(slashCommands.id, commandId), eq(slashCommands.applicationId, appId)))
      .returning();
    return deleted ?? null;
  }

  return {
    createApp,
    listApps,
    getApp,
    updateApp,
    deleteApp,
    resetSecret,
    authorize,
    exchangeToken,
    createBot,
    resetBotToken,
    getBot,
    verifyBotToken,
    createSlashCommand,
    listSlashCommands,
    updateSlashCommand,
    deleteSlashCommand,
  };
}

export type BotsService = ReturnType<typeof createBotsService>;
