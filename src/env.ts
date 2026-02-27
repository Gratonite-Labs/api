import { z } from 'zod';
import 'dotenv/config';

/**
 * Environment variable validation schema.
 * Fails fast on startup if required variables are missing or malformed.
 */
const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Database
  DATABASE_URL: z.string().url().default('postgres://gratonite:gratonite@localhost:5433/gratonite'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // MinIO
  MINIO_ENDPOINT: z.string().default('localhost'),
  MINIO_PORT: z.coerce.number().default(9000),
  MINIO_ACCESS_KEY: z.string().default('gratonite'),
  MINIO_SECRET_KEY: z.string().default('gratonite123'),
  MINIO_USE_SSL: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // JWT
  JWT_SECRET: z.string().min(32).default('dev-secret-change-me-in-production-please-now'),
  JWT_ACCESS_TOKEN_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_TOKEN_EXPIRY: z.string().default('7d'),

  // Encryption
  ENCRYPTION_KEY: z.string().default('0123456789abcdef0123456789abcdef'),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z
    .string()
    .url()
    .default('http://localhost:4000/api/v1/auth/google/callback'),

  // Apple OAuth
  APPLE_CLIENT_ID: z.string().optional(), // Service ID (e.g. com.gratonite.web)
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(), // PEM contents (newlines as \n)
  APPLE_CALLBACK_URL: z
    .string()
    .url()
    .default('http://localhost:4000/api/v1/auth/apple/callback'),

  // Facebook OAuth
  FACEBOOK_APP_ID: z.string().optional(),
  FACEBOOK_APP_SECRET: z.string().optional(),
  FACEBOOK_CALLBACK_URL: z
    .string()
    .url()
    .default('http://localhost:4000/api/v1/auth/facebook/callback'),

  // App URLs / Email delivery
  APP_ORIGIN: z.string().default('http://localhost:5173'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM_ADDRESS: z.string().email().default('no-reply@gratonite.chat'),
  SMTP_FROM_NAME: z.string().default('Gratonite'),
  SMTP_REQUIRE_TLS: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  SMTP_IGNORE_TLS: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // CORS
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173'),
  COMMUNITY_SHOP_MODERATOR_IDS: z.string().default(''),
  ECONOMY_AUDITOR_IDS: z.string().default(''),
  BUG_REPORT_ADMIN_USER_IDS: z.string().default(''),
  BUG_REPORT_ADMIN_USERNAMES: z.string().default('ferdinand'),
  AUTH_REQUIRE_EMAIL_VERIFIED_LOGIN: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  AUTH_REQUIRE_EMAIL_VERIFIED_CREATED_AFTER: z.string().optional(),

  // CDN
  CDN_BASE_URL: z.string().default('http://localhost:9000'),

  // LiveKit
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('secret'),
  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_HTTP_URL: z.string().default('http://localhost:7880'),

  // TURN/STUN (Coturn)
  TURN_URL: z.string().default('turn:localhost:3478'),
  TURN_USERNAME: z.string().default('gratonite'),
  TURN_PASSWORD: z.string().default('gratonite123'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
