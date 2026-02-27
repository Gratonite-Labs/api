import { z } from 'zod';

export const updateMemberProfileSchema = z.object({
  nickname: z.string().min(1).max(32).nullable().optional(),
  bio: z.string().max(190).nullable().optional(),
});

export const equipCustomizationSchema = z.object({
  avatarDecorationId: z.string().nullable().optional(),
  profileEffectId: z.string().nullable().optional(),
  nameplateId: z.string().nullable().optional(),
});

export type UpdateMemberProfileInput = z.infer<typeof updateMemberProfileSchema>;
export type EquipCustomizationInput = z.infer<typeof equipCustomizationSchema>;
