import { z } from 'zod';

const redirectUriSchema = z.string().url().max(200);

export const createAppSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(200).optional(),
  redirectUris: z.array(redirectUriSchema).min(1).max(10),
  botPublic: z.boolean().optional(),
  botRequireCodeGrant: z.boolean().optional(),
  termsUrl: z.string().url().max(200).optional(),
  privacyUrl: z.string().url().max(200).optional(),
});

export const updateAppSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(200).nullable().optional(),
  redirectUris: z.array(redirectUriSchema).min(1).max(10).optional(),
  botPublic: z.boolean().optional(),
  botRequireCodeGrant: z.boolean().optional(),
  termsUrl: z.string().url().max(200).nullable().optional(),
  privacyUrl: z.string().url().max(200).nullable().optional(),
});

export const authorizeSchema = z.object({
  responseType: z.enum(['code']),
  clientId: z.string(),
  redirectUri: z.string().url().max(200),
  scope: z.string().optional(),
  state: z.string().max(128).optional(),
});

export const tokenSchema = z.object({
  grantType: z.enum(['authorization_code']),
  clientId: z.string(),
  clientSecret: z.string(),
  code: z.string().max(128),
  redirectUri: z.string().url().max(200),
});

export const createSlashCommandSchema = z.object({
  name: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/),
  description: z.string().min(1).max(100),
  options: z.array(z.any()).optional(),
  guildId: z.string().optional(),
  defaultMemberPermissions: z.string().max(32).optional(),
  dmPermission: z.boolean().optional(),
});

export const updateSlashCommandSchema = z.object({
  name: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/).optional(),
  description: z.string().min(1).max(100).optional(),
  options: z.array(z.any()).optional(),
  defaultMemberPermissions: z.string().max(32).optional(),
  dmPermission: z.boolean().optional(),
});

export type CreateAppInput = z.infer<typeof createAppSchema>;
export type UpdateAppInput = z.infer<typeof updateAppSchema>;
export type AuthorizeInput = z.infer<typeof authorizeSchema>;
export type TokenInput = z.infer<typeof tokenSchema>;
export type CreateSlashCommandInput = z.infer<typeof createSlashCommandSchema>;
export type UpdateSlashCommandInput = z.infer<typeof updateSlashCommandSchema>;
