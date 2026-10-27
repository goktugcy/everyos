import { createPublicKey, sign } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { inspectPackage, sha256Hex, signPackage } from "@everyos/app-package";
import { communityEnrollmentStatement } from "@everyos/app-registry";
import { deriveKey, loadKeyFile, SecretBox } from "@everyos/security";
import { CliError } from "./project.ts";

/** Credentials are scoped to an exact origin; redirects never receive a bearer token. */
export function communityOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new CliError(
      "Community registry must be an HTTPS origin (HTTP is allowed only on localhost)",
    );
  return url.origin;
}
export class CommunityClient {
  readonly origin: string;
  readonly token: string | undefined;
  readonly fetcher: typeof fetch;
  constructor(origin: string, token?: string, fetcher: typeof fetch = fetch) {
    this.origin = communityOrigin(origin);
    this.token = token;
    this.fetcher = fetcher;
  }
  async request(
    path: string,
    method = "GET",
    body?: string | Buffer,
    binary = false,
  ): Promise<Record<string, unknown>> {
    const target = new URL(path, `${this.origin}/`);
    if (!path.startsWith("/") || path.startsWith("//") || target.origin !== this.origin)
      throw new CliError("Community requests must stay on the configured registry origin");
    const response = await this.fetcher(target, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined
          ? {}
          : { "content-type": binary ? "application/octet-stream" : "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : new Uint8Array(body) }),
    });
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new CliError("Registry response is too large");
          }
          parts.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    let data: unknown;
    try {
      data = JSON.parse(Buffer.concat(parts, size).toString("utf8"));
    } catch {
      throw new CliError(`Registry returned an invalid response (${response.status})`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new CliError("Invalid registry response");
    const record = data as Record<string, unknown>;
    if (!response.ok)
      throw new CliError(
        `Registry rejected the request (${response.status}): ${typeof record.error === "string" && /^[a-z0-9-]{1,64}$/.test(record.error) ? record.error : "request-failed"}`,
      );
    return record;
  }
  async enroll(publisherId: string, invitation: string, privateKey: string) {
    const publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    const input = { publisherId, invitation, publicKey };
    return this.request(
      "/v1/enroll",
      "POST",
      JSON.stringify({
        ...input,
        proof: sign(null, communityEnrollmentStatement(input), privateKey).toString("base64"),
      }),
    );
  }
  async submit(file: string, key: string, icon: string, screenshots: string[], changelog: string) {
    if (screenshots.length > 8)
      throw new CliError("Community submissions allow at most eight screenshots");
    const bytes = await readFile(file);
    if (bytes.length > 8 * 1024 * 1024)
      throw new CliError("Community packages may be at most 8 MiB compressed");
    const { manifest } = await inspectPackage(bytes);
    const digest = {
      appId: manifest.id,
      version: manifest.version,
      sha256: sha256Hex(bytes),
      size: bytes.length,
    };
    const signature = signPackage(digest, await readFile(key, "utf8"));
    const query = new URLSearchParams({ appId: digest.appId, version: digest.version, signature });
    const uploaded = await this.request(`/v1/artifacts/package?${query}`, "POST", bytes, true);
    const uploadImage = async (path: string) => {
      const image = await readFile(path);
      if (image.length > 2 * 1024 * 1024)
        throw new CliError("Community images may be at most 2 MiB");
      const result = await this.request("/v1/artifacts/image", "POST", image, true);
      if (typeof result.hash !== "string" || !/^[a-f0-9]{64}$/.test(result.hash))
        throw new CliError("Invalid image receipt");
      return result.hash;
    };
    const image = await uploadImage(icon),
      images: string[] = [];
    for (const screenshot of screenshots) images.push(await uploadImage(screenshot));
    return this.request(
      "/v1/submissions",
      "POST",
      JSON.stringify({ package: uploaded.hash, icon: image, screenshots: images, changelog }),
    );
  }
}
function credentialBox(path: string, create: boolean): SecretBox {
  return new SecretBox(
    deriveKey(
      loadKeyFile(`${path}.key`, { create, enforcePermissions: true }),
      "everyos/community-cli/v1",
    ),
  );
}
const credentialContext = (origin: string) => `everyos/community-token/v1:${origin}`;

export async function saveCommunityToken(
  path: string,
  origin: string,
  value: unknown,
): Promise<void> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    throw new CliError("Invalid token receipt");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const normalized = communityOrigin(origin);
  const sealed = credentialBox(path, true).seal(value, credentialContext(normalized));
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ format: "everyos-community-token/1", origin: normalized, sealed }) + "\n",
      );
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function loadCommunityToken(path: string, origin: string): Promise<string> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new CliError("Community credentials are missing or invalid; enroll with the operator");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new CliError("Invalid community credentials");
  const record = data as Record<string, unknown>;
  const normalized = communityOrigin(origin);
  if (
    record.origin !== normalized ||
    record.format !== "everyos-community-token/1" ||
    typeof record.sealed !== "string"
  )
    throw new CliError(
      "Credentials do not match this community registry; enroll with its operator",
    );
  try {
    const value = credentialBox(path, false).open(record.sealed, credentialContext(normalized));
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new CliError("Invalid community credentials");
    return value;
  } catch {
    throw new CliError(
      "Community credentials could not be decrypted; check the companion key or enroll again",
    );
  }
}
