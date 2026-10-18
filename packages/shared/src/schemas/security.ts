import { z } from "zod";
import { TWO_FACTOR_POLICIES } from "../api-types.ts";

export const TailscaleServeRequestSchema = z.strictObject({ enabled: z.boolean() });

export const LanHttpsRequestSchema = z.strictObject({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
});

export const TwoFactorPolicyRequestSchema = z.strictObject({
  required: z.enum(TWO_FACTOR_POLICIES),
});
