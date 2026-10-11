import { deriveKey, hmacSha256, randomToken, safeEqual } from "@everyos/security";

/**
 * Mutual challenge–response authentication over the Unix socket.
 *
 * Filesystem permissions on the socket (root:everyos 0660 inside a 0750
 * runtime directory) are the primary access control. The handshake adds a
 * second, independent check: only a process that can read the shared agent
 * key (root or members of the `everyos` group) can complete it, and the agent
 * proves possession of the same key so the API never talks to an impostor.
 */
const CLIENT_LABEL = "otuken-agent/v1/client";
const SERVER_LABEL = "otuken-agent/v1/server";

export function deriveAgentAuthKey(agentKey: Buffer): Buffer {
  return deriveKey(agentKey, "otuken/agent-auth/v1");
}

export function createNonce(): string {
  return randomToken(32);
}

export function clientMac(authKey: Buffer, serverNonce: string, clientNonce: string): string {
  return hmacSha256(authKey, `${CLIENT_LABEL}|${serverNonce}|${clientNonce}`).toString("base64url");
}

export function serverProof(authKey: Buffer, serverNonce: string, clientNonce: string): string {
  return hmacSha256(authKey, `${SERVER_LABEL}|${clientNonce}|${serverNonce}`).toString("base64url");
}

export function verifyClientMac(
  authKey: Buffer,
  serverNonce: string,
  clientNonce: string,
  mac: string,
): boolean {
  return safeEqual(clientMac(authKey, serverNonce, clientNonce), mac);
}

export function verifyServerProof(
  authKey: Buffer,
  serverNonce: string,
  clientNonce: string,
  proof: string,
): boolean {
  return safeEqual(serverProof(authKey, serverNonce, clientNonce), proof);
}
