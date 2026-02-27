import { Router } from 'express';
import type { AppContext } from '../../lib/context.js';
import { createAuthService } from './auth.service.js';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  usernameAvailabilitySchema,
  mfaDisableSchema,
  mfaEnableSchema,
  mfaRegenerateBackupCodesSchema,
  mfaStartSetupSchema,
  verifyEmailBulkResendSchema,
  verifyEmailConfirmSchema,
  verifyEmailRequestSchema,
} from './auth.schemas.js';
import { authRateLimiter, registerRateLimiter } from '../../middleware/rate-limiter.js';
import { logger } from '../../lib/logger.js';
import { requireAuth } from '../../middleware/auth.js';
import { isEmailDeliveryConfigured } from '../../lib/mailer.js';

export function authRouter(ctx: AppContext): Router {
  const router = Router();
  const authService = createAuthService(ctx);
  const auth = requireAuth(ctx);
  const parseCsvSet = (value: string | undefined) =>
    new Set((value ?? '').split(',').map((v) => v.trim()).filter(Boolean));
  const adminUserIds = parseCsvSet(ctx.env.BUG_REPORT_ADMIN_USER_IDS);
  const adminUsernames = parseCsvSet(ctx.env.BUG_REPORT_ADMIN_USERNAMES);
  const isAuthAdmin = (user: { userId: string; username: string }) =>
    adminUserIds.has(user.userId) || adminUsernames.has(user.username);

  // ── POST /api/v1/auth/register ─────────────────────────────────────────
  router.post('/register', registerRateLimiter, async (req, res) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid registration data',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const result = await authService.register(parsed.data);

      res.status(201).json({ email: result.email });
    } catch (err: unknown) {
      // Handle unique constraint violations
      if (err instanceof Error && err.message.includes('unique')) {
        if (err.message.includes('email')) {
          res.status(409).json({
            code: 'EMAIL_TAKEN',
            message: 'An account with this email already exists',
          });
          return;
        }
      }
      logger.error({ err }, 'Registration error');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred during registration',
      });
    }
  });

  // ── POST /api/v1/auth/login ────────────────────────────────────────────
  router.post('/login', authRateLimiter, async (req, res) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid login data',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const result = await authService.login(parsed.data, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      if ('error' in result) {
        const statusMap = {
          INVALID_CREDENTIALS: 401,
          ACCOUNT_DISABLED: 403,
          ACCOUNT_DELETED: 410,
          OAUTH_ONLY_ACCOUNT: 400,
          MFA_REQUIRED: 403,
          INVALID_MFA_CODE: 401,
          EMAIL_NOT_VERIFIED: 403,
        } as const;

        const messageMap = {
          INVALID_CREDENTIALS: 'Invalid username/email or password',
          ACCOUNT_DISABLED: 'This account has been disabled',
          ACCOUNT_DELETED: 'This account has been deleted',
          OAUTH_ONLY_ACCOUNT: 'This account uses Google sign-in. Please use that method.',
          MFA_REQUIRED: 'Two-factor authentication code required',
          INVALID_MFA_CODE: 'Invalid two-factor authentication code',
          EMAIL_NOT_VERIFIED: 'Please verify your email before signing in',
        } as const;

        const errorCode = result.error as keyof typeof statusMap;
        res.status(statusMap[errorCode]).json({
          code: result.error,
          message: messageMap[errorCode],
        });
        return;
      }

      // Set refresh token as HttpOnly cookie
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: ctx.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
      });

      res.json({
        accessToken: result.accessToken,
        user: result.user,
      });
    } catch (err) {
      logger.error({ err }, 'Login error');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred during login',
      });
    }
  });

  // ── POST /api/v1/auth/refresh ──────────────────────────────────────────
  router.post('/refresh', async (req, res) => {
    try {
      const token = req.cookies?.refreshToken ?? req.body?.refreshToken;
      if (!token) {
        res.status(401).json({
          code: 'NO_REFRESH_TOKEN',
          message: 'Refresh token is required',
        });
        return;
      }

      const result = await authService.refresh(token, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      if ('error' in result) {
        res.status(401).json({
          code: result.error,
          message: 'Invalid or expired refresh token',
        });
        return;
      }

      // Rotate cookie
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: ctx.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
      });

      res.json({ accessToken: result.accessToken });
    } catch (err) {
      logger.error({ err }, 'Token refresh error');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred during token refresh',
      });
    }
  });

  // ── GET /api/v1/auth/username-available?username=xxx ───────────────────
  router.get('/username-available', async (req, res) => {
    try {
      const parsed = usernameAvailabilitySchema.safeParse({ username: req.query['username'] });
      if (!parsed.success) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid username format',
        });
        return;
      }

      const available = await authService.checkUsernameAvailability(parsed.data.username);
      res.json({ available });
    } catch (err) {
      logger.error({ err }, 'Username check error');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred',
      });
    }
  });

  // ── POST /api/v1/auth/verify-email/request ─────────────────────────────
  router.post('/verify-email/request', authRateLimiter, async (req, res) => {
    try {
      const parsed = verifyEmailRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid email address',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      await authService.requestEmailVerificationByEmail(parsed.data.email);
      res.json({
        ok: true,
        message: 'If the account exists and is unverified, a verification email has been queued.',
      });
    } catch (err) {
      logger.error({ err }, 'Verify email request error');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred while requesting email verification',
      });
    }
  });

  // ── POST /api/v1/auth/verify-email/confirm ─────────────────────────────
  router.post('/verify-email/confirm', authRateLimiter, async (req, res) => {
    try {
      const parsed = verifyEmailConfirmSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid verification token',
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const result = await authService.confirmEmailVerificationToken(parsed.data.token);
      if (result.error) {
        const code = result.error === 'TOKEN_EXPIRED' ? 410 : 400;
        res.status(code).json({
          code: result.error,
          message: result.error === 'TOKEN_EXPIRED' ? 'Verification token expired' : 'Invalid verification token',
        });
        return;
      }

      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: ctx.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/api/v1/auth',
      });

      res.json({
        ok: true,
        accessToken: result.accessToken,
        message: 'Email verified successfully',
      });
    } catch (err) {
      logger.error({ err }, 'Verify email confirm error');
      res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred while confirming email verification',
      });
    }
  });

  // ── POST /api/v1/auth/verify-email/admin/bulk-resend-unverified ───────
  router.post('/verify-email/admin/bulk-resend-unverified', auth, authRateLimiter, async (req, res) => {
    try {
      if (!isAuthAdmin(req.user!)) {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Admin access required' });
      }

      if (!isEmailDeliveryConfigured(ctx.env)) {
        return res.status(400).json({
          code: 'SMTP_NOT_CONFIGURED',
          message: 'SMTP is not configured on the server. Configure SMTP before bulk resend.',
        });
      }

      const parsed = verifyEmailBulkResendSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid bulk resend request',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const result = await authService.resendVerificationForUnverifiedUsers(parsed.data.limit);
      return res.json({ ok: true, ...result });
    } catch (err) {
      logger.error({ err }, 'Bulk resend verification emails error');
      return res.status(500).json({
        code: 'INTERNAL_ERROR',
        message: 'An error occurred while resending verification emails',
      });
    }
  });

  // ── GET /api/v1/auth/mfa/status ────────────────────────────────────────
  router.get('/mfa/status', auth, async (req, res) => {
    try {
      const result = await authService.getMfaStatus(req.user!.userId);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'MFA status error');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred while loading MFA status' });
    }
  });

  // ── POST /api/v1/auth/mfa/setup/start ──────────────────────────────────
  router.post('/mfa/setup/start', auth, authRateLimiter, async (req, res) => {
    try {
      const parsed = mfaStartSetupSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid MFA setup request',
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const result = await authService.startMfaSetup(req.user!.userId, parsed.data);
      if ('error' in result) {
        const code = result.error === 'MFA_ALREADY_ENABLED' ? 409 : 404;
        return res.status(code).json({ code: result.error, message: result.error });
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'MFA setup start error');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred while starting MFA setup' });
    }
  });

  // ── POST /api/v1/auth/mfa/setup/enable ─────────────────────────────────
  router.post('/mfa/setup/enable', auth, authRateLimiter, async (req, res) => {
    try {
      const parsed = mfaEnableSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid MFA code',
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const result = await authService.enableMfa(req.user!.userId, parsed.data.code);
      if ('error' in result) {
        const statusMap = { MFA_SETUP_NOT_STARTED: 400, INVALID_MFA_CODE: 401 } as const;
        return res.status(statusMap[result.error]).json({ code: result.error, message: result.error });
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'MFA enable error');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred while enabling MFA' });
    }
  });

  // ── POST /api/v1/auth/mfa/disable ──────────────────────────────────────
  router.post('/mfa/disable', auth, authRateLimiter, async (req, res) => {
    try {
      const parsed = mfaDisableSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid MFA code',
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const result = await authService.disableMfa(req.user!.userId, parsed.data.code);
      if ('error' in result) {
        const statusMap = { MFA_NOT_ENABLED: 400, INVALID_MFA_CODE: 401, INTERNAL_ERROR: 500 } as const;
        return res.status(statusMap[result.error]).json({ code: result.error, message: result.error });
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'MFA disable error');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred while disabling MFA' });
    }
  });

  // ── POST /api/v1/auth/mfa/backup-codes/regenerate ──────────────────────
  router.post('/mfa/backup-codes/regenerate', auth, authRateLimiter, async (req, res) => {
    try {
      const parsed = mfaRegenerateBackupCodesSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Invalid MFA code',
          details: parsed.error.flatten().fieldErrors,
        });
      }
      const result = await authService.regenerateMfaBackupCodes(req.user!.userId, parsed.data.code);
      if ('error' in result) {
        const statusMap = { MFA_NOT_ENABLED: 400, INVALID_MFA_CODE: 401, INTERNAL_ERROR: 500 } as const;
        return res.status(statusMap[result.error]).json({ code: result.error, message: result.error });
      }
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'MFA backup code regeneration error');
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'An error occurred while regenerating backup codes' });
    }
  });

  // ── POST /api/v1/auth/logout ───────────────────────────────────────────
  router.post('/logout', (_req, res) => {
    res.clearCookie('refreshToken', { path: '/api/v1/auth' });
    res.json({ success: true });
  });

  return router;
}
