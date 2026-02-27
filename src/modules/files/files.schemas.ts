import { z } from 'zod';

const CONTROL_CHARS_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const BASE64ISH_REGEX = /^[A-Za-z0-9+/_=-]+$/;

export const uploadFileSchema = z.object({
  purpose: z
    .enum(['upload', 'emoji', 'sticker', 'avatar', 'banner', 'server-icon'])
    .default('upload'),
  contextId: z.string().optional(), // guildId, userId, etc.
  description: z
    .string()
    .max(1024)
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const sanitized = value.replace(CONTROL_CHARS_REGEX, '').trim();
      return sanitized.length > 0 ? sanitized : undefined;
    }), // alt text
  spoiler: z
    .string()
    .transform((v) => v === 'true')
    .or(z.boolean())
    .default(false),
  // Voice message fields (only for purpose='upload' with audio content)
  isVoiceMessage: z
    .string()
    .transform((v) => v === 'true')
    .or(z.boolean())
    .default(false),
  durationSecs: z.coerce.number().int().min(0).max(600).optional(), // max 10 minutes
  waveform: z
    .string()
    .max(4096)
    .regex(BASE64ISH_REGEX, 'waveform must be base64-like encoded data')
    .optional(), // base64 encoded waveform data
}).superRefine((data, ctx) => {
  if (data.isVoiceMessage) {
    if (typeof data.durationSecs !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'durationSecs is required when isVoiceMessage is true',
        path: ['durationSecs'],
      });
    }
    if (!data.waveform) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'waveform is required when isVoiceMessage is true',
        path: ['waveform'],
      });
    }
    return;
  }

  if (data.durationSecs !== undefined || data.waveform !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'durationSecs/waveform metadata requires isVoiceMessage=true',
      path: ['isVoiceMessage'],
    });
  }
});

export type UploadFileInput = z.infer<typeof uploadFileSchema>;
