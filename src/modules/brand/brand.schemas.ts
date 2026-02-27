import { z } from 'zod';

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color')
  .nullable();

export const updateBrandSchema = z.object({
  colorPrimary: hexColor.optional(),
  colorSecondary: hexColor.optional(),
  colorAccent: hexColor.optional(),
  gradientType: z.enum(['linear', 'radial', 'mesh', 'none']).optional(),
  gradientConfig: z
    .object({
      angle: z.number().optional(),
      stops: z.array(z.object({ color: z.string(), position: z.number() })).optional(),
      meshPoints: z.array(z.unknown()).optional(),
    })
    .nullable()
    .optional(),
  backgroundBlur: z.number().int().min(0).max(20).optional(),
  fontDisplay: z.string().max(64).nullable().optional(),
  fontBody: z.string().max(64).nullable().optional(),
  iconPack: z.enum(['outlined', 'filled', 'duotone', 'playful', 'custom']).optional(),
  noiseOpacity: z.number().min(0).max(0.08).optional(),
  glassOpacity: z.number().min(0.5).max(0.95).optional(),
  cornerStyle: z.enum(['rounded', 'sharp', 'pill']).optional(),
  messageLayout: z.enum(['cozy', 'compact', 'bubbles', 'cards']).optional(),
});

export const updateCssSchema = z.object({
  css: z.string().max(50000),
});

export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
