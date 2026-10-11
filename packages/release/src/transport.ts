import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { get } from "node:https";
import { realpath } from "node:fs/promises";
import { readBounded } from "./config.ts";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["::ffff:0:0", 96],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedV6.addSubnet(network, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicReleaseAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

/** DNS is resolved and checked once, then the checked address is pinned to the connection. */
export async function download(
  url: URL,
  limit: number,
  redirectHosts: readonly string[] = [],
  redirects = 0,
  deadline = Date.now() + 10 * 60_000,
): Promise<Buffer> {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new Error("Release downloads require HTTPS");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicReleaseAddress(a.address)))
    throw new Error("Release source is not a public address");
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => request.destroy(new Error("Release download deadline exceeded")),
      Math.max(1, deadline - Date.now()),
    );
    const request = get(
      url,
      {
        lookup: (_hostname, options, callback) =>
          options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          clearTimeout(timer);
          response.destroy();
          let target: URL;
          try {
            target = new URL(response.headers.location ?? "", url);
          } catch {
            reject(new Error("Invalid release redirect"));
            return;
          }
          if (
            redirects >= 4 ||
            (target.hostname !== url.hostname && !redirectHosts.includes(target.hostname))
          ) {
            reject(new Error("Untrusted release redirect"));
            return;
          }
          void download(target, limit, redirectHosts, redirects + 1, deadline).then(
            resolve,
            reject,
          );
          return;
        }
        if (response.statusCode !== 200) {
          clearTimeout(timer);
          response.destroy();
          reject(new Error(`Release server returned ${response.statusCode}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            request.destroy(new Error("Release download is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        response.on("aborted", () => {
          clearTimeout(timer);
          reject(new Error("Release download was interrupted"));
        });
        response.on("end", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
      },
    );
    request.setTimeout(60_000, () => request.destroy(new Error("Release download timed out")));
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export interface ReleaseSource {
  source: string;
  publicKey: string;
  redirectHosts: string[];
}
export async function readReleaseFile(
  config: ReleaseSource,
  path: string,
  limit: number,
): Promise<Buffer> {
  if (
    !/^(latest\/download\/release\.json|download\/v\d+\.\d+\.\d+\/everyos_\d+\.\d+\.\d+_(arm64|amd64)\.deb)$/.test(
      path,
    )
  )
    throw new Error("Invalid release path");
  const base = new URL(`${config.source.replace(/\/$/, "")}/`);
  if (base.protocol === "file:") {
    const root = fileURLToPath(base),
      file = join(root, path);
    if ((await realpath(file)) !== file) throw new Error("Release files cannot be symlinks");
    return readBounded(file, limit);
  }
  return download(new URL(path, base), limit, config.redirectHosts);
}
