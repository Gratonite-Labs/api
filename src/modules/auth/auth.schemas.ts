import { z } from 'zod';

/**
 * Zod validation schemas for auth endpoints.
 * All user input is validated server-side, regardless of client-side validation.
 */

/** Username: 2–32 chars, lowercase only, alphanumeric + dots + underscores */
const usernameRegex = /^[a-z0-9._]{2,32}$/;

/** Password: 8–128 chars, at least 1 letter + 1 number */
const passwordRegex = /^(?=.*[a-zA-Z])(?=.*\d).{8,128}$/;

export const registerSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(passwordRegex, 'Password must contain at least 1 letter and 1 number'),
});

export const loginSchema = z.object({
  login: z.string().min(1, 'Username or email is required').max(255),
  password: z.string().min(1, 'Password is required').max(128),
  mfaCode: z
    .string()
    .length(6, 'MFA code must be 6 digits')
    .regex(/^\d{6}$/, 'MFA code must be numeric')
    .optional(),
  mfaBackupCode: z
    .string()
    .min(4, 'Backup code is required')
    .max(64, 'Backup code is too long')
    .optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const usernameAvailabilitySchema = z.object({
  username: z
    .string()
    .min(2)
    .max(32)
    .regex(usernameRegex, 'Invalid username format'),
});

export const verifyEmailRequestSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
});

export const verifyEmailConfirmSchema = z.object({
  token: z.string().min(16, 'Verification token is required').max(512),
});

export const mfaStartSetupSchema = z.object({
  deviceLabel: z.string().min(1).max(64).optional(),
});

export const mfaEnableSchema = z.object({
  code: z
    .string()
    .length(6, 'MFA code must be 6 digits')
    .regex(/^\d{6}$/, 'MFA code must be numeric'),
});

export const mfaDisableSchema = z.object({
  code: z
    .string()
    .length(6, 'MFA code must be 6 digits')
    .regex(/^\d{6}$/, 'MFA code must be numeric'),
});

export const mfaRegenerateBackupCodesSchema = z.object({
  code: z
    .string()
    .length(6, 'MFA code must be 6 digits')
    .regex(/^\d{6}$/, 'MFA code must be numeric'),
});

export const verifyEmailBulkResendSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type VerifyEmailRequestInput = z.infer<typeof verifyEmailRequestSchema>;
export type VerifyEmailConfirmInput = z.infer<typeof verifyEmailConfirmSchema>;
export type MfaStartSetupInput = z.infer<typeof mfaStartSetupSchema>;
export type MfaEnableInput = z.infer<typeof mfaEnableSchema>;
export type MfaDisableInput = z.infer<typeof mfaDisableSchema>;
export type MfaRegenerateBackupCodesInput = z.infer<typeof mfaRegenerateBackupCodesSchema>;
export type VerifyEmailBulkResendInput = z.infer<typeof verifyEmailBulkResendSchema>;
