import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { addressAllowed } from "@everyos/catalogs";

/** Where EveryOS talks to Google. Tests point these at a local fake. */
export interface GoogleEndpoints {
  /** Token exchange, refresh and revocation. */
  oauth: string;
  /** Drive v3 and its upload endpoint. */
  api: string;
  /** The consent page the browser opens. */
  accounts: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  oauth: "https://oauth2.googleapis.com",
  api: "https://www.googleapis.com",
  accounts: "https://accounts.google.com",
};

export type GoogleFailure = "network" | "timeout" | "status" | "too-large" | "unsafe-address";

export class GoogleHttpError extends Error {
  readonly kind: GoogleFailure;
  readonly status: number | null;
  /** Google's own error reason (`invalid_grant`, `notFound`, `storageQuotaExceeded`…). */
  readonly reason: string | null;

  constructor(
    kind: GoogleFailure,
    message: string,
    status: number | null = null,
    reason: string | null = null,
  ) {
    super(message);
    this.name = "GoogleHttpError";
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

export interface GoogleRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** A form or JSON text, bytes, or a stream with its `Content-Length` header set. */
  body?: string | Buffer | Readable;
  signal?: AbortSignal;
  /** Until the response headers arrive (bodies stream without a deadline of their own). */
  timeoutMs?: number;
}

/**
 * Requests to Google's fixed endpoints only. DNS is resolved once and pinned, only public
 * addresses are used, redirects are never followed and response bodies stream.
 */
export class GoogleHttp {
  readonly endpoints: GoogleEndpoints;
  readonly #allowPrivate: boolean;

  constructor(options: { endpoints?: GoogleEndpoints; allowPrivate?: boolean } = {}) {
    this.endpoints = options.endpoints ?? GOOGLE_ENDPOINTS;
    // Only the test fake listens on a private address.
    this.#allowPrivate = options.allowPrivate ?? false;
  }

  async request(input: GoogleRequest): Promise<IncomingMessage> {
    const target = new URL(input.url);
    if (
      ![this.endpoints.oauth, this.endpoints.api].some(
        (base) => new URL(base).origin === target.origin,
      )
    )
      throw new GoogleHttpError("unsafe-address", "Not a Google endpoint");
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    let pinned: { address: string; family: number };
    try {
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname, { all: true, verbatim: true });
      if (
        !addresses.length ||
        addresses.some(({ address }) => !addressAllowed(address, this.#allowPrivate))
      )
        throw new GoogleHttpError("unsafe-address", "Address not allowed");
      pinned = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
    } catch (error) {
      if (error instanceof GoogleHttpError) throw error;
      throw new GoogleHttpError("network", "Google could not be resolved");
    }
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 30_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
        target,
        {
          method: input.method,
          agent: false,
          family: pinned.family,
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
          headers: {
            "User-Agent": "EveryOS-Drive/1",
            "Accept-Encoding": "identity",
            ...input.headers,
          },
        },
        (response) => {
          signal.removeEventListener("abort", abort);
          // A slow body is ended by the caller's own signal, not the header deadline.
          if (input.signal)
            input.signal.addEventListener("abort", () => response.destroy(), { once: true });
          resolve(response);
        },
      );
      const abort = () => {
        request.destroy();
        reject(
          new GoogleHttpError(
            timeout.aborted && !input.signal?.aborted ? "timeout" : "network",
            "Google request ended",
          ),
        );
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      request.on("error", () => {
        signal.removeEventListener("abort", abort);
        reject(new GoogleHttpError("network", "Google request failed"));
      });
      const body = input.body;
      if (body === undefined) request.end();
      else if (typeof body === "string" || Buffer.isBuffer(body)) request.end(body);
      else {
        body.on("error", () => request.destroy());
        body.pipe(request);
      }
    });
  }

  /** A JSON request; non-2xx answers become errors carrying Google's reason. */
  async json<T>(
    input: GoogleRequest & { json?: unknown; form?: Record<string, string> },
  ): Promise<T> {
    const response = await this.request({
      ...input,
      ...(input.json !== undefined
        ? {
            body: JSON.stringify(input.json),
            headers: { "Content-Type": "application/json; charset=utf-8", ...input.headers },
          }
        : input.form
          ? {
              body: new URLSearchParams(input.form).toString(),
              headers: { "Content-Type": "application/x-www-form-urlencoded", ...input.headers },
            }
          : {}),
    });
    const text = await readText(response, 4 * 1024 * 1024);
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) throw statusError(status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Reads a whole (small) body. */
export async function readText(response: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      response.destroy();
      throw new GoogleHttpError("too-large", "Google answer too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Google's error formats: `{error: "invalid_grant"}` (OAuth) and `{error: {errors: [{reason}]}}`. */
export function statusError(status: number, text: string): GoogleHttpError {
  const reason = (() => {
    try {
      const parsed = JSON.parse(text) as {
        error?: string | { status?: string; errors?: Array<{ reason?: string }> };
      };
      if (typeof parsed.error === "string") return parsed.error;
      return parsed.error?.errors?.[0]?.reason ?? parsed.error?.status ?? null;
    } catch {
      return null;
    }
  })();
  return new GoogleHttpError(
    "status",
    `Google answered ${status}`,
    status,
    reason?.slice(0, 64) ?? null,
  );
}
