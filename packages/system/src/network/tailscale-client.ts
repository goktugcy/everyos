import { request } from "node:http";
import type { TailscaleStatus } from "@otuken/shared";
import { pathKind } from "../fs-utils.ts";
import { parseTailscaleStatus, tailscaleUnavailable } from "../linux/tailscale.ts";

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

/** Tailscale status from tailscaled's LocalAPI (no CLI parsing, no network access). */
export async function getTailscaleStatus(
  sockets: readonly string[] = SOCKETS,
): Promise<TailscaleStatus> {
  let socket: string | null = null;
  let denied = false;
  for (const candidate of sockets) {
    const kind = await pathKind(candidate);
    if (kind === "socket") {
      socket = candidate;
      break;
    }
    if (kind === "denied") denied = true;
  }
  if (!socket) return tailscaleUnavailable(denied ? "permission-denied" : "not-detected");
  try {
    return parseTailscaleStatus(await getJson(socket, "/localapi/v0/status?peers=true", 5_000));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const status = (error as { status?: number }).status;
    if (code === "EACCES" || status === 403) return tailscaleUnavailable("permission-denied");
    return tailscaleUnavailable("socket-missing");
  }
}
