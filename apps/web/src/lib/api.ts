import { CSRF_HEADER, isErrorCode, type ApiErrorBody, type ErrorCode } from "@everyos/shared";
import { traceApiRequest } from "./api-traffic.ts";

export type ClientErrorCode = ErrorCode | "NETWORK" | "UNKNOWN";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ClientErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get retryAfterSeconds(): number | null {
    const details = this.details as { retryAfterSeconds?: unknown } | undefined;
    return typeof details?.retryAfterSeconds === "number" ? details.retryAfterSeconds : null;
  }
}

let csrfToken: string | null = null;
let unauthenticatedHandler: (() => void) | null = null;
let lockedHandler: (() => void) | null = null;
let twoFactorHandler: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when an authenticated request reports that the session ended. */
export function onUnauthenticated(handler: (() => void) | null): void {
  unauthenticatedHandler = handler;
}

/** Called when the server reports that the session is locked (HTTP 423). */
export function onSessionLocked(handler: (() => void) | null): void {
  lockedHandler = handler;
}

/** Called when the server requires a two-factor setup before anything else (HTTP 403). */
export function onTwoFactorRequired(handler: (() => void) | null): void {
  twoFactorHandler = handler;
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Suppress the global "session ended" handler (used while probing the session). */
  quiet401?: boolean;
  /** Let the request outlive the page (used to flush unsaved state on unload). */
  keepalive?: boolean;
  /** Raw request body (e.g. an uploaded file) sent with its own content type. */
  raw?: { body: Blob | ArrayBuffer; contentType: string };
  /** Extra request headers (e.g. a desktop app instance token). */
  headers?: Record<string, string>;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...options.headers, Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.raw) headers["Content-Type"] = options.raw.contentType;
  if (method !== "GET" && csrfToken) headers[CSRF_HEADER] = csrfToken;
  const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const finish = traceApiRequest(
    method,
    path,
    options.raw
      ? options.raw.body instanceof Blob
        ? options.raw.body.size
        : options.raw.body.byteLength
      : body
        ? new TextEncoder().encode(body).length
        : 0,
  );

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body !== undefined ? { body } : {}),
      ...(options.raw ? { body: options.raw.body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.keepalive ? { keepalive: true } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    finish(0, null);
    throw new ApiRequestError(0, "NETWORK", "Network request failed");
  }

  if (response.status === 204) {
    finish(204, 0);
    return undefined as T;
  }
  let payload: unknown;
  let receivedBytes: number | null = null;
  try {
    const text = await response.text();
    receivedBytes = new TextEncoder().encode(text).length;
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = null;
  }
  finish(response.status, receivedBytes);
  if (response.ok) return payload as T;

  const error = (payload as Partial<ApiErrorBody> | null)?.error;
  const code: ClientErrorCode = isErrorCode(error?.code) ? error.code : "UNKNOWN";
  if (response.status === 401 && code === "UNAUTHENTICATED" && !options.quiet401)
    unauthenticatedHandler?.();
  if (response.status === 423 && code === "SESSION_LOCKED") lockedHandler?.();
  if (response.status === 403 && code === "TWO_FACTOR_REQUIRED") twoFactorHandler?.();
  throw new ApiRequestError(
    response.status,
    code,
    error?.message ?? response.statusText,
    error?.details,
  );
}

/** POST event stream: sends CSRF once and never retries a potentially mutating agent turn. */
export async function postApiEvents(
  path: string,
  body: unknown,
  signal: AbortSignal,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  if (csrfToken) headers[CSRF_HEADER] = csrfToken;
  const response = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorBody | null;
    const code = isErrorCode(payload?.error?.code) ? payload.error.code : "UNKNOWN";
    if (response.status === 401 && code === "UNAUTHENTICATED") unauthenticatedHandler?.();
    if (response.status === 423 && code === "SESSION_LOCKED") lockedHandler?.();
    if (response.status === 403 && code === "TWO_FACTOR_REQUIRED") twoFactorHandler?.();
    throw new ApiRequestError(
      response.status,
      code,
      "Agent request failed",
      payload?.error?.details,
    );
  }
  if (!response.body) throw new ApiRequestError(502, "UNKNOWN", "Missing chat stream");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    event = "message",
    data = "",
    complete = false;
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data) {
            const payload = JSON.parse(data) as unknown;
            onEvent(event, payload);
            if (event === "complete") complete = true;
          }
          event = "message";
          data = "";
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
      if (buffer.length > 256 * 1024)
        throw new ApiRequestError(502, "UNKNOWN", "Chat event too large");
    }
    if (!signal.aborted && !complete)
      throw new ApiRequestError(502, "AGENT_OPERATION_FAILED", "Chat interrupted");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Uploads a file as the raw request body with progress reports (fetch cannot
 * report upload progress). Errors map to `ApiRequestError` like `api()`.
 */
export function uploadWithProgress<T = unknown>(
  path: string,
  file: Blob,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const finish = traceApiRequest("POST", path, file.size);
    xhr.open("POST", `/api${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (csrfToken) xhr.setRequestHeader(CSRF_HEADER, csrfToken);
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total || file.size);
    xhr.onerror = () => {
      finish(0, null);
      reject(new ApiRequestError(0, "NETWORK", "Network request failed"));
    };
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.onload = () => {
      finish(xhr.status, new TextEncoder().encode(xhr.responseText).length);
      if (xhr.status >= 200 && xhr.status < 300) {
        let body: unknown;
        try {
          body = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
        } catch {
          body = undefined;
        }
        resolve(body as T);
        return;
      }
      let error: ApiErrorBody["error"] | undefined;
      try {
        error = (JSON.parse(xhr.responseText) as Partial<ApiErrorBody>).error;
      } catch {
        error = undefined;
      }
      const code: ClientErrorCode = isErrorCode(error?.code) ? error.code : "UNKNOWN";
      if (xhr.status === 401 && code === "UNAUTHENTICATED") unauthenticatedHandler?.();
      if (xhr.status === 423 && code === "SESSION_LOCKED") lockedHandler?.();
      if (xhr.status === 403 && code === "TWO_FACTOR_REQUIRED") twoFactorHandler?.();
      reject(
        new ApiRequestError(xhr.status, code, error?.message ?? xhr.statusText, error?.details),
      );
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
