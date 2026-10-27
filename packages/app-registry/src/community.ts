import { isAppId, isPublisherId, isReservedNamespace, isVersion } from "@everyos/app-manifest";
import { z } from "zod";

export const CommunityPublisherId = z
  .string()
  .refine((id) => isPublisherId(id) && !isReservedNamespace(id));
export const CommunityAppId = z.string().refine((id) => isAppId(id) && !isReservedNamespace(id));
export const CommunityVersion = z.string().refine(isVersion);
export const CommunityHash = z.string().regex(/^[a-f0-9]{64}$/);
export const CommunityId = z.string().uuid();
export const CommunityPublicKey = z
  .string()
  .max(512)
  .regex(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n?$/);
export const CommunityInvitation = z.strictObject({
  publisherId: CommunityPublisherId,
  name: z.string().trim().min(1).max(64),
  email: z.email().max(254),
  emailVerified: z.literal(true),
  reason: z.string().trim().min(1).max(500),
  recovery: z.boolean().default(false),
});
export const CommunityEnrollment = z.strictObject({
  publisherId: CommunityPublisherId,
  invitation: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  publicKey: CommunityPublicKey,
  proof: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
/** The invitation is bound to both the namespace and the key that receives it. */
export function communityEnrollmentStatement(input: {
  publisherId: string;
  invitation: string;
  publicKey: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: "everyos-community-enrollment/1",
      publisherId: input.publisherId,
      invitation: input.invitation,
      publicKey: input.publicKey,
    }),
  );
}
export const CommunitySubmission = z.strictObject({
  package: CommunityHash,
  icon: CommunityHash,
  screenshots: z.array(CommunityHash).max(8).default([]),
  changelog: z.string().max(8000).default(""),
});
export const CommunityReview = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().min(1).max(2000),
});
export const CommunityRevocation = z.strictObject({
  appId: CommunityAppId,
  version: z.union([z.literal("*"), CommunityVersion]),
  reason: z.string().trim().min(1).max(500),
});
export const CommunityReport = z.strictObject({
  appId: CommunityAppId,
  version: CommunityVersion.optional(),
  reason: z.string().trim().min(10).max(2000),
});
