import { hash, verify } from 'argon2';
import * as jose from 'jose';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'crypto';
import { generateSecret as generateTotpSecret, generateURI as generateTotpUri, verify as verifyTotp } from 'otplib';
import QRCode from 'qrcode';
import { and, eq, isNull, or } from 'drizzle-orm';
import { users, userProfiles, userSettings, emailVerificationTokens } from '@gratonite/db';
import type { AppContext } from '../../lib/context.js';
import { generateId } from '../../lib/snowflake.js';
import { logger } from '../../lib/logger.js';
import { sendVerificationEmail } from '../../lib/mailer.js';
import type { RegisterInput, LoginInput } from './auth.schemas.js';

// ============================================================================
// Constants
// ============================================================================

/** Argon2id configuration (OWASP recommended) */
const ARGON2_OPTIONS = {
  type: 2 as const, // argon2id
  memoryCost: 65536, // 64MB
  timeCost: 3,
  parallelism: 4,
};

/** Refresh token validity in seconds (7 days) */
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60;
const EMAIL_VERIFICATION_TTL_MS = 30 * 60 * 1000;
const MFA_PENDING_SETUP_TTL_SECONDS = 10 * 60;
const MFA_BACKUP_CODES_COUNT = 8;

// ============================================================================
// Auth Service
// ============================================================================

export function createAuthService(ctx: AppContext) {
  const jwtSecret = new TextEncoder().encode(ctx.env.JWT_SECRET);
  const emailVerifyCutoff = ctx.env.AUTH_REQUIRE_EMAIL_VERIFIED_CREATED_AFTER
    ? new Date(ctx.env.AUTH_REQUIRE_EMAIL_VERIFIED_CREATED_AFTER)
    : null;
  const hasValidEmailVerifyCutoff = !!emailVerifyCutoff && !Number.isNaN(emailVerifyCutoff.getTime());

  // ── Password Hashing ────────────────────────────────────────────────────

  async function hashPassword(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  // ── Token Generation ────────────────────────────────────────────────────

  async function generateAccessToken(payload: {
    userId: string;
    username: string;
    tier: string;
  }): Promise<string> {
    return new jose.SignJWT({
      userId: payload.userId,
      username: payload.username,
      tier: payload.tier,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(ctx.env.JWT_ACCESS_TOKEN_EXPIRY)
      .sign(jwtSecret);
  }

  async function verifyAccessToken(token: string) {
    try {
      const { payload } = await jose.jwtVerify(token, jwtSecret);
      return payload as {
        userId: string;
        username: string;
        tier: string;
        iat: number;
        exp: number;
      };
    } catch {
      return null;
    }
  }

  function generateRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  function hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  function hashVerificationToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  function deriveEncryptionKey(): Buffer {
    return createHash('sha256').update(ctx.env.ENCRYPTION_KEY).digest();
  }

  function encryptSecret(plaintext: string): string {
    const key = deriveEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
  }

  function decryptSecret(payload: string): string {
    const [version, ivB64, tagB64, cipherB64] = payload.split(':');
    if (version !== 'v1' || !ivB64 || !tagB64 || !cipherB64) {
      throw new Error('Invalid encrypted secret format');
    }
    const key = deriveEncryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(cipherB64, 'base64url')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  async function storeRefreshToken(
    userId: string,
    token: string,
    meta: { ip?: string; userAgent?: string; deviceType?: string },
  ): Promise<void> {
    const tokenHash = hashRefreshToken(token);
    const key = `auth:refresh:${tokenHash}`;

    await ctx.redis.setex(
      key,
      REFRESH_TOKEN_TTL,
      JSON.stringify({
        userId,
        tokenHash,
        createdAt: Date.now(),
        ...meta,
      }),
    );

    // Track token family for breach detection
    const familyKey = `auth:family:${userId}`;
    await ctx.redis.sadd(familyKey, tokenHash);
    await ctx.redis.expire(familyKey, REFRESH_TOKEN_TTL);
  }

  async function rotateRefreshToken(
    oldToken: string,
    meta: { ip?: string; userAgent?: string; deviceType?: string },
  ): Promise<{ userId: string; newToken: string } | null> {
    const oldHash = hashRefreshToken(oldToken);
    const key = `auth:refresh:${oldHash}`;

    // Get and delete old token atomically
    const data = await ctx.redis.get(key);
    if (!data) return null;

    await ctx.redis.del(key);

    const parsed = JSON.parse(data) as { userId: string };

    // Generate new refresh token
    const newToken = generateRefreshToken();
    await storeRefreshToken(parsed.userId, newToken, meta);

    return { userId: parsed.userId, newToken };
  }

  // ── Registration ────────────────────────────────────────────────────────

  async function register(input: RegisterInput) {
    const userId = generateId();
    const passwordHash = await hashPassword(input.password);

    // Auto-generate a unique temp username from the ID prefix.
    // User will set their real username in the onboarding flow.
    const tempUsername = `user_${userId.toString().slice(-12)}`;

    await ctx.db.insert(users).values({
      id: userId,
      username: tempUsername,
      email: input.email.toLowerCase(),
      emailVerified: false,
      passwordHash,
      dateOfBirth: null,
    });

    await ctx.db.insert(userProfiles).values({
      userId,
      displayName: tempUsername,
    });

    await ctx.db.insert(userSettings).values({ userId });

    logger.info({ userId, tempUsername }, 'User registered (email+password only)');

    try {
      const { token } = await createEmailVerificationToken(userId);
      const mailResult = await sendVerificationEmail({
        env: ctx.env,
        toEmail: input.email.toLowerCase(),
        displayName: tempUsername,
        token,
      });
      if (!mailResult.sent) {
        logger.info({ userId, token, reason: mailResult.reason }, 'Email verification token generated (delivery fallback)');
      }
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to create/send email verification token');
    }

    return { email: input.email.toLowerCase() };
  }

  // ── Login ───────────────────────────────────────────────────────────────

  async function login(input: LoginInput, meta: { ip?: string; userAgent?: string }) {
    // Find user by username or email
    const [user] = await ctx.db
      .select()
      .from(users)
      .where(
        or(
          eq(users.username, input.login.toLowerCase()),
          eq(users.email, input.login.toLowerCase()),
        ),
      )
      .limit(1);

    if (!user) {
      return { error: 'INVALID_CREDENTIALS' as const };
    }

    if (user.disabled) {
      return { error: 'ACCOUNT_DISABLED' as const };
    }

    if (user.deletedAt) {
      return { error: 'ACCOUNT_DELETED' as const };
    }

    const shouldEnforceByCutoff =
      hasValidEmailVerifyCutoff && user.createdAt.getTime() >= emailVerifyCutoff!.getTime();
    const shouldEnforceEmailVerification =
      (ctx.env.AUTH_REQUIRE_EMAIL_VERIFIED_LOGIN || shouldEnforceByCutoff) && !user.emailVerified;

    if (shouldEnforceEmailVerification) {
      return { error: 'EMAIL_NOT_VERIFIED' as const };
    }

    // Verify password
    if (!user.passwordHash) {
      return { error: 'OAUTH_ONLY_ACCOUNT' as const };
    }

    const passwordValid = await verifyPassword(user.passwordHash, input.password);
    if (!passwordValid) {
      // Track failed attempts
      const failKey = `failed_login:${input.login.toLowerCase()}`;
      const failures = await ctx.redis.incr(failKey);
      if (failures === 1) {
        await ctx.redis.expire(failKey, 900); // 15 min TTL
      }

      logger.warn(
        { username: input.login, failures, ip: meta.ip },
        'Failed login attempt',
      );

      return { error: 'INVALID_CREDENTIALS' as const };
    }

    if (user.mfaSecret) {
      const hasTotp = !!input.mfaCode;
      const hasBackup = !!input.mfaBackupCode;
      if (!hasTotp && !hasBackup) {
        return { error: 'MFA_REQUIRED' as const };
      }

      if (hasTotp) {
        let secret = '';
        try {
          secret = decryptSecret(user.mfaSecret);
        } catch (err) {
          logger.error({ err, userId: user.id }, 'Failed to decrypt MFA secret during login');
          return { error: 'INVALID_CREDENTIALS' as const };
        }

        const isValid = verifyTotp({ token: input.mfaCode!, secret, window: 1 });
        if (!isValid) {
          return { error: 'INVALID_MFA_CODE' as const };
        }
      } else if (hasBackup) {
        const normalized = normalizeBackupCode(input.mfaBackupCode!);
        const backupCodeHashes = user.mfaBackupCodes ? safeParseStringArray(user.mfaBackupCodes) : [];
        let matchedIndex = -1;

        for (let i = 0; i < backupCodeHashes.length; i++) {
          const candidate = backupCodeHashes[i];
          if (!candidate) continue;
          const ok = await verify(candidate, normalized).catch(() => false);
          if (ok) {
            matchedIndex = i;
            break;
          }
        }

        if (matchedIndex < 0) {
          return { error: 'INVALID_MFA_CODE' as const };
        }

        const nextHashes = backupCodeHashes.filter((_, i) => i !== matchedIndex);
        await ctx.db
          .update(users)
          .set({ mfaBackupCodes: JSON.stringify(nextHashes) })
          .where(eq(users.id, user.id));
      }
    }

    // Clear failed attempts
    await ctx.redis.del(`failed_login:${input.login.toLowerCase()}`);

    // Get profile for display name
    const [profile] = await ctx.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, user.id))
      .limit(1);

    // Generate tokens
    const accessToken = await generateAccessToken({
      userId: user.id,
      username: user.username,
      tier: profile?.tier ?? 'free',
    });

    const refreshToken = generateRefreshToken();
    await storeRefreshToken(user.id, refreshToken, meta);

    logger.info({ userId: user.id, username: user.username }, 'User logged in');

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: profile?.displayName ?? user.username,
        avatarHash: profile?.avatarHash ?? null,
        tier: profile?.tier ?? 'free',
      },
    };
  }

  // ── Token Refresh ───────────────────────────────────────────────────────

  async function refresh(
    token: string,
    meta: { ip?: string; userAgent?: string },
  ) {
    const result = await rotateRefreshToken(token, meta);
    if (!result) {
      return { error: 'INVALID_REFRESH_TOKEN' as const };
    }

    // Get user data for new access token
    const [user] = await ctx.db
      .select()
      .from(users)
      .where(eq(users.id, result.userId))
      .limit(1);

    if (!user) {
      return { error: 'USER_NOT_FOUND' as const };
    }

    const [profile] = await ctx.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, user.id))
      .limit(1);

    const accessToken = await generateAccessToken({
      userId: user.id,
      username: user.username,
      tier: profile?.tier ?? 'free',
    });

    return {
      accessToken,
      refreshToken: result.newToken,
    };
  }

  // ── Username availability check ─────────────────────────────────────────

  async function checkUsernameAvailability(username: string): Promise<boolean> {
    const [existing] = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username.toLowerCase()))
      .limit(1);

    return !existing;
  }

  async function createEmailVerificationToken(userId: string) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashVerificationToken(token);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

    await ctx.db.insert(emailVerificationTokens).values({
      id: generateId(),
      userId,
      tokenHash,
      expiresAt,
    });

    return { token, expiresAt };
  }

  async function requestEmailVerificationByEmail(email: string) {
    const normalizedEmail = email.toLowerCase();
    if (shouldSkipVerificationEmailDelivery(normalizedEmail)) {
      logger.info({ email: normalizedEmail }, 'Skipping verification email resend for test/non-deliverable domain');
      return { ok: true as const };
    }
    const [user] = await ctx.db
      .select({
        id: users.id,
        emailVerified: users.emailVerified,
        email: users.email,
      })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (!user || user.emailVerified) {
      // Privacy-preserving response
      return { ok: true as const };
    }

    const { token, expiresAt } = await createEmailVerificationToken(user.id);
    const mailResult = await sendVerificationEmail({
      env: ctx.env,
      toEmail: user.email,
      token,
    });
    if (!mailResult.sent) {
      logger.info({ userId: user.id, token, expiresAt, reason: mailResult.reason }, 'Email verification requested (delivery fallback)');
    } else {
      logger.info({ userId: user.id, expiresAt }, 'Email verification requested');
    }
    return { ok: true as const };
  }

  async function resendVerificationForUnverifiedUsers(limit = 100) {
    const rows = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        emailVerified: users.emailVerified,
        displayName: userProfiles.displayName,
      })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.emailVerified, false))
      .limit(limit);

    let sent = 0;
    let fallback = 0;
    let failed = 0;

    for (const row of rows) {
      if (shouldSkipVerificationEmailDelivery(row.email)) {
        logger.info({ userId: row.id, email: row.email }, 'Skipping bulk verification resend for test/non-deliverable domain');
        continue;
      }
      try {
        const { token } = await createEmailVerificationToken(row.id);
        const mailResult = await sendVerificationEmail({
          env: ctx.env,
          toEmail: row.email,
          displayName: row.displayName ?? null,
          token,
        });

        if (mailResult.sent) {
          sent += 1;
        } else {
          fallback += 1;
          logger.info({ userId: row.id, reason: mailResult.reason }, 'Bulk verification resend fallback');
        }
      } catch (err) {
        failed += 1;
        logger.warn({ err, userId: row.id }, 'Bulk verification resend failed');
      }
    }

    return {
      scanned: rows.length,
      sent,
      fallback,
      failed,
    };
  }

  async function confirmEmailVerificationToken(rawToken: string) {
    const tokenHash = hashVerificationToken(rawToken);
    const now = new Date();

    // 1. Look up token row
    const [row] = await ctx.db
      .select()
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, tokenHash),
          isNull(emailVerificationTokens.usedAt),
        ),
      )
      .limit(1);

    // 2. Check INVALID_TOKEN / TOKEN_EXPIRED
    if (!row) {
      return { error: 'INVALID_TOKEN' as const };
    }

    if (row.expiresAt.getTime() < now.getTime()) {
      return { error: 'TOKEN_EXPIRED' as const };
    }

    // 3. Look up user + profile (matching login() pattern)
    const [user] = await ctx.db
      .select({ id: users.id, username: users.username, disabled: users.disabled, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);

    const [profile] = await ctx.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, row.userId))
      .limit(1);

    // 4. Check !user
    if (!user) {
      return { error: 'INVALID_TOKEN' as const };
    }

    // 5. Check account disabled
    if (user.disabled) {
      return { error: 'ACCOUNT_DISABLED' as const };
    }

    // 6. Check account deleted
    if (user.deletedAt) {
      return { error: 'ACCOUNT_DELETED' as const };
    }

    // 7. Stamp usedAt (mark token consumed)
    await ctx.db
      .update(emailVerificationTokens)
      .set({ usedAt: now })
      .where(eq(emailVerificationTokens.id, row.id));

    // 8. Update emailVerified = true
    await ctx.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, row.userId));

    // 9. Log after user guard succeeds and tokens are being generated
    logger.info({ userId: row.userId }, 'Email verified — issuing session tokens');

    // 10. Generate accessToken (using tier from userProfiles)
    const accessToken = await generateAccessToken({
      userId: user.id,
      username: user.username,
      tier: profile?.tier ?? 'free',
    });

    // 11. Generate + store refreshToken
    const refreshToken = generateRefreshToken();
    await storeRefreshToken(user.id, refreshToken, {});

    // 12. Return
    return {
      ok: true as const,
      userId: user.id,
      accessToken,
      refreshToken,
    };
  }

  async function getMfaStatus(userId: string) {
    const [user] = await ctx.db
      .select({ mfaSecret: users.mfaSecret, mfaBackupCodes: users.mfaBackupCodes })
      .from(users)
      .where(eq(users.id, BigInt(userId)))
      .limit(1);

    const pendingKey = `auth:mfa:pending:${userId}`;
    const pending = await ctx.redis.exists(pendingKey);
    const backupCodes = user?.mfaBackupCodes ? safeParseStringArray(user.mfaBackupCodes) : [];

    return {
      enabled: !!user?.mfaSecret,
      pendingSetup: pending === 1,
      backupCodeCount: backupCodes.length,
    };
  }

  async function startMfaSetup(userId: string, opts?: { deviceLabel?: string }) {
    const [user] = await ctx.db
      .select({ email: users.email, username: users.username, mfaSecret: users.mfaSecret })
      .from(users)
      .where(eq(users.id, BigInt(userId)))
      .limit(1);

    if (!user) return { error: 'USER_NOT_FOUND' as const };
    if (user.mfaSecret) return { error: 'MFA_ALREADY_ENABLED' as const };

    const secret = generateTotpSecret();
    const accountLabel = opts?.deviceLabel?.trim() || user.email || user.username;
    const otpauthUrl = generateTotpUri({
      secret,
      accountName: accountLabel,
      issuer: 'Gratonite',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });

    const pendingKey = `auth:mfa:pending:${userId}`;
    await ctx.redis.setex(
      pendingKey,
      MFA_PENDING_SETUP_TTL_SECONDS,
      JSON.stringify({ secret, createdAt: Date.now() }),
    );

    return {
      secret,
      otpauthUrl,
      qrCodeDataUrl,
      expiresInSeconds: MFA_PENDING_SETUP_TTL_SECONDS,
    };
  }

  async function enableMfa(userId: string, code: string) {
    const pendingKey = `auth:mfa:pending:${userId}`;
    const payload = await ctx.redis.get(pendingKey);
    if (!payload) return { error: 'MFA_SETUP_NOT_STARTED' as const };

    let parsed: { secret: string };
    try {
      parsed = JSON.parse(payload) as { secret: string };
    } catch {
      return { error: 'MFA_SETUP_NOT_STARTED' as const };
    }

    const valid = verifyTotp({ token: code, secret: parsed.secret, window: 1 });
    if (!valid) return { error: 'INVALID_MFA_CODE' as const };

    const backupCodesPlain = generateBackupCodes();
    const backupCodeHashes = await Promise.all(backupCodesPlain.map((c) => hash(c, ARGON2_OPTIONS)));

    await ctx.db
      .update(users)
      .set({
        mfaSecret: encryptSecret(parsed.secret),
        mfaBackupCodes: JSON.stringify(backupCodeHashes),
      })
      .where(eq(users.id, BigInt(userId)));

    await ctx.redis.del(pendingKey);

    return {
      ok: true as const,
      backupCodes: backupCodesPlain,
    };
  }

  async function disableMfa(userId: string, code: string) {
    const [user] = await ctx.db
      .select({ mfaSecret: users.mfaSecret })
      .from(users)
      .where(eq(users.id, BigInt(userId)))
      .limit(1);
    if (!user?.mfaSecret) return { error: 'MFA_NOT_ENABLED' as const };

    let secret = '';
    try {
      secret = decryptSecret(user.mfaSecret);
    } catch {
      return { error: 'INTERNAL_ERROR' as const };
    }

    if (!verifyTotp({ token: code, secret, window: 1 })) {
      return { error: 'INVALID_MFA_CODE' as const };
    }

    await ctx.db
      .update(users)
      .set({ mfaSecret: null, mfaBackupCodes: null })
      .where(eq(users.id, BigInt(userId)));

    await ctx.redis.del(`auth:mfa:pending:${userId}`);
    return { ok: true as const };
  }

  async function regenerateMfaBackupCodes(userId: string, code: string) {
    const [user] = await ctx.db
      .select({ mfaSecret: users.mfaSecret })
      .from(users)
      .where(eq(users.id, BigInt(userId)))
      .limit(1);
    if (!user?.mfaSecret) return { error: 'MFA_NOT_ENABLED' as const };

    let secret = '';
    try {
      secret = decryptSecret(user.mfaSecret);
    } catch {
      return { error: 'INTERNAL_ERROR' as const };
    }

    if (!verifyTotp({ token: code, secret, window: 1 })) {
      return { error: 'INVALID_MFA_CODE' as const };
    }

    const backupCodesPlain = generateBackupCodes();
    const backupCodeHashes = await Promise.all(backupCodesPlain.map((c) => hash(c, ARGON2_OPTIONS)));

    await ctx.db
      .update(users)
      .set({ mfaBackupCodes: JSON.stringify(backupCodeHashes) })
      .where(eq(users.id, BigInt(userId)));

    return { ok: true as const, backupCodes: backupCodesPlain };
  }

  function generateBackupCodes(): string[] {
    return Array.from({ length: MFA_BACKUP_CODES_COUNT }, () => {
      return randomBytes(4).toString('hex').toUpperCase();
    });
  }

  function normalizeBackupCode(code: string): string {
    return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  function shouldSkipVerificationEmailDelivery(email: string): boolean {
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes('@')) return true;
    const [, domain = ''] = normalized.split('@');
    if (!domain) return true;
    const blockedDomains = new Set([
      'example.test',
      'invalid',
      'localhost',
      'local',
      'test',
    ]);
    if (blockedDomains.has(domain)) return true;
    if (domain.endsWith('.test')) return true;
    if (domain.endsWith('.invalid')) return true;
    return false;
  }

  function safeParseStringArray(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  return {
    hashPassword,
    verifyPassword,
    generateAccessToken,
    verifyAccessToken,
    register,
    login,
    refresh,
    checkUsernameAvailability,
    requestEmailVerificationByEmail,
    confirmEmailVerificationToken,
    getMfaStatus,
    startMfaSetup,
    enableMfa,
    disableMfa,
    regenerateMfaBackupCodes,
    resendVerificationForUnverifiedUsers,
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
