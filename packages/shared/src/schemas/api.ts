import { z } from "zod";
import { AUDIT_OUTCOMES, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../api-types.ts";
import { SUPPORTED_LOCALES } from "../locale.ts";
import { ROLES } from "../permissions.ts";

/* Primitive field schemas */

export const LocaleSchema = z.enum(SUPPORTED_LOCALES);
export const RoleSchema = z.enum(ROLES);
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);

export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "username-format");

export const DisplayNameSchema = z.string().trim().min(1).max(64);

export const PasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const TotpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "totp-format");

export const RecoveryCodeSchema = z.string().trim().min(8).max(64);

/* Setup */

export const SetupRequestSchema = z.strictObject({
  setupToken: z.string().trim().min(1).max(256),
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  password: PasswordSchema,
  locale: LocaleSchema,
});

export type SetupRequest = z.infer<typeof SetupRequestSchema>;

/* Login */

export const LoginRequestSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginTotpRequestSchema = z
  .strictObject({
    challengeId: z.string().min(1).max(128),
    code: TotpCodeSchema.optional(),
    recoveryCode: RecoveryCodeSchema.optional(),
  })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), {
    message: "exactly-one-of-code-or-recovery-code",
  });

export type LoginTotpRequest = z.infer<typeof LoginTotpRequestSchema>;

/* Account (self-service) */

export const ChangePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: PasswordSchema,
});

export const UpdateAccountRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema.optional(),
    locale: LocaleSchema.optional(),
  })
  .refine((v) => v.displayName !== undefined || v.locale !== undefined, {
    message: "empty-update",
  });

export const TotpEnableRequestSchema = z.strictObject({ code: TotpCodeSchema });

export const TotpDisableRequestSchema = z.strictObject({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  code: TotpCodeSchema,
});

export const PasswordConfirmationSchema = z.strictObject({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

/* User administration */

export const CreateUserRequestSchema = z.strictObject({
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  password: PasswordSchema,
  role: RoleSchema,
  locale: LocaleSchema.optional(),
});

export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema.optional(),
    role: RoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: "empty-update",
  });

export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const ResetPasswordRequestSchema = z.strictObject({ newPassword: PasswordSchema });

/* Audit */

export const AuditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  action: z
    .string()
    .max(64)
    .regex(/^[a-z0-9_.:-]+$/)
    .optional(),
});
