import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

export class CatalogError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "CatalogError";
    this.reason = reason;
  }
}

const reserved = new BlockList();
const reservedV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  reserved.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  reservedV6.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const alwaysDenied = new BlockList();
const alwaysDeniedV6 = new BlockList();
alwaysDenied.addSubnet("169.254.0.0", 16, "ipv4");
alwaysDenied.addSubnet("0.0.0.0", 8, "ipv4");
alwaysDenied.addSubnet("224.0.0.0", 3, "ipv4");
alwaysDeniedV6.addSubnet("fe80::", 10, "ipv6");
alwaysDeniedV6.addSubnet("ff00::", 8, "ipv6");
alwaysDeniedV6.addSubnet("::ffff:0:0", 96, "ipv6");
alwaysDeniedV6.addAddress("::", "ipv6");

export function addressAllowed(address: string, allowPrivate = false): boolean {
  const version = isIP(address);
  if (version === 0 || address.includes("%")) return false;
  const family = version === 4 ? "ipv4" : "ipv6";
  if ((version === 4 ? alwaysDenied : alwaysDeniedV6).check(address, family)) return false;
  if (allowPrivate) return true;
  return (
    !(version === 4 ? reserved : reservedV6).check(address, family) &&
    (version === 4 || globalV6.check(address, "ipv6"))
  );
}

export interface CatalogFetcher {
  get(url: string, maxBytes?: number): Promise<Buffer>;
}

/** One bounded sync session. DNS is checked and pinned for every redirect hop. */
export function createCatalogFetcher(
  options: {
    allowPrivate?: boolean;
    signal?: AbortSignal;
    resolve?: (
      hostname: string,
      options: { all: true; verbatim: true },
    ) => Promise<{ address: string; family: number }[]>;
    maxTotalBytes?: number;
    deadlineMs?: number;
  } = {},
): CatalogFetcher {
  let remaining = options.maxTotalBytes ?? 32 * 1024 * 1024;
  const deadline = AbortSignal.timeout(options.deadlineMs ?? 90_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  return {
    async get(input, maxBytes = 512 * 1024) {
      let url = new URL(input);
      for (let hop = 0; hop <= 4; hop++) {
        signal.throwIfAborted();
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
          throw new CatalogError("invalid-url");
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
              const abort = () => reject(new CatalogError("timeout"));
              signal.addEventListener("abort", abort, { once: true });
              const pending = options.resolve
                ? options.resolve(hostname, { all: true, verbatim: true })
                : lookup(hostname, { all: true, verbatim: true });
              void pending.then(
                (addresses) => {
                  signal.removeEventListener("abort", abort);
                  resolve(addresses);
                },
                () => {
                  signal.removeEventListener("abort", abort);
                  reject(new CatalogError("dns-error"));
                },
              );
              if (signal.aborted) abort();
            });
        if (
          !addresses.length ||
          addresses.some(({ address }) => !addressAllowed(address, options.allowPrivate))
        )
          throw new CatalogError("unsafe-address");
        const pinned = addresses.find((entry) => entry.family === 4) ?? addresses[0];
        if (!pinned) throw new CatalogError("unsafe-address");
        const result = await new Promise<Buffer | URL>((resolve, reject) => {
          const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
            url,
            {
              signal,
              agent: false,
              family: pinned.family,
              headers: {
                Accept: "*/*",
                "Accept-Encoding": "identity",
                "User-Agent": "EveryOS-Catalog/1",
              },
              lookup: (_hostname, _options, callback) =>
                callback(null, pinned.address, pinned.family),
            },
            (response) => {
              if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
                const location = response.headers.location;
                response.destroy();
                if (!location) return reject(new CatalogError("invalid-redirect"));
                try {
                  resolve(new URL(location, url));
                } catch {
                  reject(new CatalogError("invalid-redirect"));
                }
                return;
              }
              if (response.statusCode !== 200) {
                response.destroy();
                reject(new CatalogError("http-error"));
                return;
              }
              if (
                response.headers["content-encoding"] &&
                response.headers["content-encoding"] !== "identity"
              ) {
                response.destroy();
                reject(new CatalogError("unsupported-encoding"));
                return;
              }
              if (Number(response.headers["content-length"]) > Math.min(maxBytes, remaining)) {
                response.destroy();
                reject(new CatalogError("too-large"));
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                remaining -= chunk.length;
                if (size > maxBytes || remaining < 0) {
                  response.destroy(new CatalogError("too-large"));
                  return;
                }
                chunks.push(chunk);
              });
              response.once("error", reject);
              response.once("end", () => resolve(Buffer.concat(chunks, size)));
            },
          );
          request.setTimeout(15_000, () => request.destroy(new CatalogError("timeout")));
          request.once("error", reject);
          request.end();
        });
        if (Buffer.isBuffer(result)) return result;
        url = result;
      }
      throw new CatalogError("too-many-redirects");
    },
  };
}
