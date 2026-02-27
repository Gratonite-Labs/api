import { randomBytes, createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { users, userProfiles, userSettings } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import type { AuthService } from './auth.service.js';

// ============================================================================
// Types
// ============================================================================

export type OAuthProvider = 'google' | 'apple' | 'facebook';

interface OAuthUserInfo {
  providerId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

// ============================================================================
// OAuth Service
// ============================================================================

export function createOAuthService(ctx: AppContext, authService: AuthService) {
  const STATE_TTL = 600; // 10 minutes

  // ── State management (CSRF protection) ──────────────────────────────

  async function generateState(provider: OAuthProvider): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await ctx.redis.setex(`oauth:state:${state}`, STATE_TTL, provider);
    return state;
  }

  async function validateState(state: string, provider: OAuthProvider): Promise<boolean> {
    const stored = await ctx.redis.get(`oauth:state:${state}`);
    if (stored !== provider) return false;
    await ctx.redis.del(`oauth:state:${state}`);
    return true;
  }

  // ── Google OAuth ────────────────────────────────────────────────────

  function getGoogleAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: ctx.env.GOOGLE_CLIENT_ID!,
      redirect_uri: ctx.env.GOOGLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async function exchangeGoogleCode(code: string): Promise<OAuthUserInfo> {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: ctx.env.GOOGLE_CLIENT_ID!,
        client_secret: ctx.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: ctx.env.GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Google token exchange failed: ${err}`);
    }

    const tokens = (await tokenRes.json()) as { access_token: string; id_token?: string };

    // Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userRes.ok) throw new Error('Failed to fetch Google user info');

    const profile = (await userRes.json()) as {
      id: string;
      email: string;
      name?: string;
      picture?: string;
    };

    return {
      providerId: profile.id,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.picture,
    };
  }

  // ── Apple OAuth ─────────────────────────────────────────────────────

  function getAppleAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: ctx.env.APPLE_CLIENT_ID!,
      redirect_uri: ctx.env.APPLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'name email',
      state,
      response_mode: 'form_post',
    });
    return `https://appleid.apple.com/auth/authorize?${params}`;
  }

  async function generateAppleClientSecret(): Promise<string> {
    // Apple requires a JWT signed with your private key as the client_secret
    const { SignJWT, importPKCS8 } = await import('jose');
    const privateKey = await importPKCS8(
      ctx.env.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      'ES256',
    );

    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: ctx.env.APPLE_KEY_ID! })
      .setIssuer(ctx.env.APPLE_TEAM_ID!)
      .setAudience('https://appleid.apple.com')
      .setSubject(ctx.env.APPLE_CLIENT_ID!)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  async function exchangeAppleCode(code: string): Promise<OAuthUserInfo> {
    const clientSecret = await generateAppleClientSecret();

    const tokenRes = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: ctx.env.APPLE_CLIENT_ID!,
        client_secret: clientSecret,
        redirect_uri: ctx.env.APPLE_CALLBACK_URL,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Apple token exchange failed: ${err}`);
    }

    const tokens = (await tokenRes.json()) as { id_token: string };

    // Decode the id_token to get user info (Apple includes sub and email in id_token)
    const { decodeJwt } = await import('jose');
    const payload = decodeJwt(tokens.id_token) as {
      sub: string;
      email?: string;
    };

    if (!payload.sub) throw new Error('Apple id_token missing sub claim');

    return {
      providerId: payload.sub,
      email: payload.email ?? `${payload.sub}@privaterelay.appleid.com`,
      name: undefined, // Apple only sends name on first auth, handled via form_post user field
    };
  }

  // ── Facebook OAuth ──────────────────────────────────────────────────

  function getFacebookAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: ctx.env.FACEBOOK_APP_ID!,
      redirect_uri: ctx.env.FACEBOOK_CALLBACK_URL,
      response_type: 'code',
      scope: 'email,public_profile',
      state,
    });
    return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
  }

  async function exchangeFacebookCode(code: string): Promise<OAuthUserInfo> {
    // Exchange code for access token
    const tokenParams = new URLSearchParams({
      client_id: ctx.env.FACEBOOK_APP_ID!,
      client_secret: ctx.env.FACEBOOK_APP_SECRET!,
      redirect_uri: ctx.env.FACEBOOK_CALLBACK_URL,
      code,
    });

    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?${tokenParams}`,
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Facebook token exchange failed: ${err}`);
    }

    const { access_token } = (await tokenRes.json()) as { access_token: string };

    // Get user info
    const userRes = await fetch(
      `https://graph.facebook.com/v19.0/me?fields=id,name,email,picture.type(large)&access_token=${access_token}`,
    );

    if (!userRes.ok) throw new Error('Failed to fetch Facebook user info');

    const profile = (await userRes.json()) as {
      id: string;
      name?: string;
      email?: string;
      picture?: { data?: { url?: string } };
    };

    return {
      providerId: profile.id,
      email: profile.email ?? `${profile.id}@facebook.placeholder`,
      name: profile.name,
      avatarUrl: profile.picture?.data?.url,
    };
  }

  // ── Provider configuration check ───────────────────────────────────

  function isProviderConfigured(provider: OAuthProvider): boolean {
    switch (provider) {
      case 'google':
        return !!(ctx.env.GOOGLE_CLIENT_ID && ctx.env.GOOGLE_CLIENT_SECRET);
      case 'apple':
        return !!(
          ctx.env.APPLE_CLIENT_ID &&
          ctx.env.APPLE_TEAM_ID &&
          ctx.env.APPLE_KEY_ID &&
          ctx.env.APPLE_PRIVATE_KEY
        );
      case 'facebook':
        return !!(ctx.env.FACEBOOK_APP_ID && ctx.env.FACEBOOK_APP_SECRET);
    }
  }

  // ── Get authorization URL ──────────────────────────────────────────

  async function getAuthUrl(provider: OAuthProvider): Promise<string> {
    const state = await generateState(provider);
    switch (provider) {
      case 'google':
        return getGoogleAuthUrl(state);
      case 'apple':
        return getAppleAuthUrl(state);
      case 'facebook':
        return getFacebookAuthUrl(state);
    }
  }

  // ── Handle callback ────────────────────────────────────────────────

  async function handleCallback(
    provider: OAuthProvider,
    code: string,
    state: string,
    meta: { ip?: string; userAgent?: string },
  ): Promise<
    | { accessToken: string; refreshToken: string }
    | { error: string }
  > {
    // Validate state
    const stateValid = await validateState(state, provider);
    if (!stateValid) {
      return { error: 'Invalid or expired OAuth state' };
    }

    // Exchange code for user info
    let userInfo: OAuthUserInfo;
    try {
      switch (provider) {
        case 'google':
          userInfo = await exchangeGoogleCode(code);
          break;
        case 'apple':
          userInfo = await exchangeAppleCode(code);
          break;
        case 'facebook':
          userInfo = await exchangeFacebookCode(code);
          break;
      }
    } catch (err) {
      logger.error({ err, provider }, 'OAuth code exchange failed');
      return { error: 'Failed to authenticate with provider' };
    }

    // Determine the provider ID column
    const providerIdColumn = {
      google: 'googleId',
      apple: 'appleId',
      facebook: 'facebookId',
    }[provider] as 'googleId' | 'appleId' | 'facebookId';

    // Check if user already exists with this provider ID
    const [existingByProvider] = await ctx.db
      .select()
      .from(users)
      .where(eq(users[providerIdColumn], userInfo.providerId))
      .limit(1);

    if (existingByProvider) {
      // User exists — issue tokens
      const [profile] = await ctx.db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, existingByProvider.id))
        .limit(1);

      const accessToken = await authService.generateAccessToken({
        userId: existingByProvider.id,
        username: existingByProvider.username,
        tier: profile?.tier ?? 'free',
      });

      const refreshToken = randomBytes(48).toString('base64url');
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      await ctx.redis.setex(
        `auth:refresh:${tokenHash}`,
        7 * 24 * 60 * 60,
        JSON.stringify({
          userId: existingByProvider.id,
          tokenHash,
          createdAt: Date.now(),
          ...meta,
        }),
      );

      logger.info({ userId: existingByProvider.id, provider }, 'OAuth login');
      return { accessToken, refreshToken };
    }

    // Check if user exists with the same email
    const [existingByEmail] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.email, userInfo.email.toLowerCase()))
      .limit(1);

    if (existingByEmail) {
      // Link the OAuth provider to existing account
      await ctx.db
        .update(users)
        .set({ [providerIdColumn]: userInfo.providerId, emailVerified: true })
        .where(eq(users.id, existingByEmail.id));

      const [profile] = await ctx.db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, existingByEmail.id))
        .limit(1);

      const accessToken = await authService.generateAccessToken({
        userId: existingByEmail.id,
        username: existingByEmail.username,
        tier: profile?.tier ?? 'free',
      });

      const refreshToken = randomBytes(48).toString('base64url');
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      await ctx.redis.setex(
        `auth:refresh:${tokenHash}`,
        7 * 24 * 60 * 60,
        JSON.stringify({
          userId: existingByEmail.id,
          tokenHash,
          createdAt: Date.now(),
          ...meta,
        }),
      );

      logger.info({ userId: existingByEmail.id, provider }, 'OAuth linked to existing account');
      return { accessToken, refreshToken };
    }

    // Create new user
    const userId = generateId();
    const baseUsername = (userInfo.name ?? userInfo.email.split('@')[0])
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '')
      .slice(0, 28);

    // Ensure unique username
    let username = baseUsername || 'user';
    let suffix = 0;
    while (true) {
      const candidate = suffix === 0 ? username : `${username}${suffix}`;
      const [existing] = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, candidate))
        .limit(1);
      if (!existing) {
        username = candidate;
        break;
      }
      suffix++;
    }

    const displayName = userInfo.name ?? username;

    await ctx.db.insert(users).values({
      id: userId,
      username,
      email: userInfo.email.toLowerCase(),
      emailVerified: true,
      [providerIdColumn]: userInfo.providerId,
    });

    await ctx.db.insert(userProfiles).values({
      userId,
      displayName,
    });

    await ctx.db.insert(userSettings).values({
      userId,
    });

    logger.info({ userId, username, provider }, 'OAuth user registered');

    const accessToken = await authService.generateAccessToken({
      userId,
      username,
      tier: 'free',
    });

    const refreshToken = randomBytes(48).toString('base64url');
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    await ctx.redis.setex(
      `auth:refresh:${tokenHash}`,
      7 * 24 * 60 * 60,
      JSON.stringify({
        userId,
        tokenHash,
        createdAt: Date.now(),
        ...meta,
      }),
    );

    return { accessToken, refreshToken };
  }

  return {
    isProviderConfigured,
    getAuthUrl,
    handleCallback,
  };
}

export type OAuthService = ReturnType<typeof createOAuthService>;
