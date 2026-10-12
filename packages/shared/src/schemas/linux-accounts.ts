import { z } from "zod";

export const LinuxAccountNameSchema = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}\$?$/);
export const LinuxAccountSchema = z.strictObject({
  name: LinuxAccountNameSchema,
  uid: z.number().int().positive(),
  gid: z.number().int().nonnegative(),
  home: z.string().startsWith("/").max(4096),
  shell: z.string().startsWith("/").max(4096),
});
export const LinuxBindingSchema = z.strictObject({
  userId: z.string().uuid(),
  account: LinuxAccountNameSchema,
  uid: z.number().int().positive(),
});
export const LinuxPasswordSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !/[\r\n\0]/.test(p));
export const LinuxBindSchema = z.strictObject({
  userId: z.string().uuid(),
  account: LinuxAccountNameSchema,
  linuxPassword: LinuxPasswordSchema,
});
export const LinuxBindRequestSchema = LinuxBindSchema.omit({ userId: true }).extend({
  currentPassword: z.string().min(1).max(1024),
});
export const LinuxUnbindSchema = z.strictObject({ userId: z.string().uuid() });
export const LinuxUnlockSchema = z.strictObject({ linuxPassword: LinuxPasswordSchema });
export const LinuxAccountStatusSchema = z.strictObject({
  account: LinuxAccountSchema.nullable(),
  privilegedUntil: z.number().nullable(),
});
