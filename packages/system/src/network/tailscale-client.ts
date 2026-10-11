import { request } from "node:http";
import type { TailscaleDetails, TailscalePeers, TailscaleStatus } from "@everyos/shared";
import { pathKind } from "../fs-utils.ts";
import {
  parseTailscaleDetails,
  parseTailscalePeers,
  parseTailscaleStatus,
  tailscaleDetailsUnavailable,
  tailscaleUnavailable,
} from "../linux/tailscale.ts";

const SOCKETS = ["/var/run/tailscale/tailscaled.sock", "/run/tailscale/tailscaled.sock"];
const MAX_BYTES = 4 * 1024 * 1024;

function getJson(socketPath: string, path: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      // LocalAPI requires this exact Host header.
      {
        socketPath,
        path,
        method: "GET",
        headers: { Host: "local-tailscaled.sock" },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) req.destroy(new Error("response too large"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(
              Object.assign(new Error(`LocalAPI ${res.statusCode}`), { status: res.statusCode }),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Invalid Tailscale status response"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

type Unavailable = "socket-missing" | "permission-denied" | "not-detected";

async function findSocket(
  sockets: readonly string[],
): Promise<{ socket: string } | { reason: Unavailable }> {
  let denied = false;
  for (const candidate of sockets) {
    const kind = await pathKind(candidate);
    if (kind === "socket") return { socket: candidate };
    if (kind === "denied") denied = true;
  }
  return { reason: denied ? "permission-denied" : "not-detected" };
}

const failure = (error: unknown): Unavailable => {
  const code = (error as NodeJS.ErrnoException).code;
  const status = (error as { status?: number }).status;
  return code === "EACCES" || status === 403 ? "permission-denied" : "socket-missing";
};

/** Tailscale status from tailscaled's LocalAPI (no CLI parsing, no network access). */
export async function getTailscaleStatus(
  sockets: readonly string[] = SOCKETS,
): Promise<TailscaleStatus> {
  const found = await findSocket(sockets);
  if ("reason" in found) return tailscaleUnavailable(found.reason);
  const { socket } = found;
  try {
    return parseTailscaleStatus(await getJson(socket, "/localapi/v0/status?peers=true", 5_000));
  } catch (error) {
    return tailscaleUnavailable(failure(error));
  }
}

/** Status, preferences and Serve configuration of this node (read-only LocalAPI calls). */
export async function getTailscaleDetails(
  sockets: readonly string[] = SOCKETS,
): Promise<TailscaleDetails> {
  const found = await findSocket(sockets);
  if ("reason" in found) return tailscaleDetailsUnavailable(found.reason);
  const { socket } = found;
  let status: unknown;
  try {
    status = await getJson(socket, "/localapi/v0/status?peers=false", 5_000);
  } catch (error) {
    return tailscaleDetailsUnavailable(failure(error));
  }
  // Older versions or restricted access may refuse these; the rest still shows.
  const [prefs, serve] = await Promise.all([
    getJson(socket, "/localapi/v0/prefs", 5_000).catch(() => null),
    getJson(socket, "/localapi/v0/serve-config", 5_000).catch(() => null),
  ]);
  return parseTailscaleDetails(status, prefs, serve);
}

/** The tailnet's other devices. */
export async function getTailscalePeers(
  sockets: readonly string[] = SOCKETS,
): Promise<TailscalePeers> {
  const found = await findSocket(sockets);
  if ("reason" in found) return { status: { available: false, reason: found.reason }, peers: [] };
  const { socket } = found;
  try {
    return parseTailscalePeers(await getJson(socket, "/localapi/v0/status?peers=true", 5_000));
  } catch (error) {
    return { status: { available: false, reason: failure(error) }, peers: [] };
  }
}
