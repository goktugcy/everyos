import { CSRF_HEADER, isErrorCode, type ApiErrorBody, type ErrorCode } from "@otuken/shared";

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

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Suppress the global "session ended" handler (used while probing the session). */
  quiet401?: boolean;
  /** Let the request outlive the page (used to flush unsaved state on unload). */
  keepalive?: boolean;
  /** Raw request body (e.g. an uploaded file) sent with its own content type. */
  raw?: { body: Blob; contentType: string };
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.raw) headers["Content-Type"] = options.raw.contentType;
  if (method !== "GET" && csrfToken) headers[CSRF_HEADER] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.raw ? { body: options.raw.body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.keepalive ? { keepalive: true } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiRequestError(0, "NETWORK", "Network request failed");
  }

  if (response.status === 204) return undefined as T;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok) return payload as T;

  const error = (payload as Partial<ApiErrorBody> | null)?.error;
  const code: ClientErrorCode = isErrorCode(error?.code) ? error.code : "UNKNOWN";
  if (response.status === 401 && code === "UNAUTHENTICATED" && !options.quiet401)
    unauthenticatedHandler?.();
  if (response.status === 423 && code === "SESSION_LOCKED") lockedHandler?.();
  throw new ApiRequestError(
    response.status,
    code,
    error?.message ?? response.statusText,
    error?.details,
  );
}

/**
 * Uploads a file as the raw request body with progress reports (fetch cannot
 * report upload progress). Errors map to `ApiRequestError` like `api()`.
 */
export function uploadWithProgress(
  path: string,
  file: Blob,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (csrfToken) xhr.setRequestHeader(CSRF_HEADER, csrfToken);
    xhr.upload.onprogress = (event) => onProgress(event.loaded, event.total || file.size);
    xhr.onerror = () => reject(new ApiRequestError(0, "NETWORK", "Network request failed"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
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
      reject(
        new ApiRequestError(xhr.status, code, error?.message ?? xhr.statusText, error?.details),
      );
    };
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
