import { createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const MiB = 1024 * 1024;
const DEFAULT_PART_BYTES = 16 * MiB;
/** S3 allows 10,000 parts. */
const MAX_PARTS = 9_000;
const MAX_OBJECT_BYTES = 5 * 1024 * MiB * 1024;
const ATTEMPTS = 3;
const MAX_ANSWER_BYTES = 8 * MiB;
const MAX_PAGES = 10_000;
/** Uploads get extra time for their body on top of the request timeout. */
const SLOWEST_UPLOAD_BYTES_PER_SECOND = 32 * 1024;
const EMPTY = new Uint8Array(0);
/** S3 codes worth another attempt even when the status says otherwise (a 200 can carry them). */
const RETRY_CODES = new Set(["InternalError", "ServiceUnavailable", "SlowDown", "RequestTimeout"]);

/** An S3-compatible bucket backups are copied to: AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO. */
export interface S3Target {
  /** `https://s3.eu-central-1.amazonaws.com`, `http://192.168.1.10:9000`… */
  endpoint: string;
  /** `eu-central-1`; `auto` for R2, `us-east-1` for MinIO. */
  region: string;
  bucket: string;
  /** "" or a folder such as `everyos/`; keys are prefix + name. */
  prefix: string;
  /** `endpoint/bucket/key` when true, `bucket.endpoint-host/key` otherwise. */
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3ClientOptions {
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  /** Bytes per buffered part and the largest single PUT. S3 needs 5 MiB; smaller is for tests. */
  partSize?: number | undefined;
  /** Per request (default 60 s); uploads get extra time for their body. */
  timeoutMs?: number | undefined;
  /** The first retry waits this long (default 500 ms), the next one twice as long. */
  retryDelayMs?: number | undefined;
}

/** An object directly under the target's prefix. */
export interface S3Object {
  /** The key without the prefix. */
  name: string;
  size: number;
  lastModified: number;
}

export interface S3PutOptions {
  signal?: AbortSignal | undefined;
  onProgress?: ((sentBytes: number) => void) | undefined;
  contentType?: string | undefined;
}

/**
 * A failed S3 request. `code` is S3's own (`AccessDenied`, `NoSuchBucket`,
 * `SignatureDoesNotMatch`…) or `network`, `timeout`, `aborted`, `http-<status>` and the client's
 * own checks. Messages never carry credentials, signatures or the answer's text.
 */
export class S3Error extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "S3Error";
    this.code = code;
    this.status = status;
  }
}

/** What a Signature Version 4 signature covers. Every header given is signed. */
export interface SigningInput {
  method: string;
  /** The decoded path (`/bucket/my file.tar`). */
  path: string;
  query: ReadonlyArray<readonly [string, string]>;
  /** Must include `host` and `x-amz-date` (`20150830T123600Z`). */
  headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the payload. */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** AWS's URI encoding: everything but `A-Z a-z 0-9 - _ . ~` as UTF-8 `%XX`. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** S3's canonical URI: each segment encoded once, `/` kept, nothing normalized. */
export function canonicalPath(path: string): string {
  return path.split("/").map(uriEncode).join("/");
}

/** Encoded `name=value` pairs sorted by name, then value. */
export function canonicalQuery(query: ReadonlyArray<readonly [string, string]>): string {
  return query
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** Signs a request with AWS Signature Version 4 and returns its `Authorization` header. */
export function signV4(input: SigningInput): { authorization: string; signature: string } {
  const headers = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const amzDate = headers.find(([name]) => name === "x-amz-date")?.[1] ?? "";
  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) throw new Error("An x-amz-date header is required");
  const signedHeaders = headers.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method,
    canonicalPath(input.path),
    canonicalQuery(input.query),
    headers.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  let key = hmac(`AWS4${input.secretAccessKey}`, day);
  for (const part of [input.region, input.service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key)
    .update(["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n"))
    .digest("hex");
  return {
    signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Why a target cannot be used, or null when it can. */
export function validateS3Target(target: S3Target): string | null {
  let endpoint: URL;
  try {
    endpoint = new URL(target.endpoint);
  } catch {
    return "The endpoint is not a URL";
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
    return "The endpoint must start with https:// or http://";
  if (endpoint.username || endpoint.password)
    return "The endpoint must not contain a user name or password";
  if (endpoint.search || endpoint.hash || /[?#]/.test(target.endpoint))
    return "The endpoint must not contain a query or fragment";
  if (endpoint.pathname !== "/") return "The endpoint must not contain a path";
  const bucket = target.bucket;
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(bucket)
  )
    return "The bucket name is not valid";
  if (!target.pathStyle) {
    if (isIP(endpoint.hostname.replace(/^\[|\]$/g, "")))
      return "An IP address endpoint needs path-style requests";
    // The provider's wildcard certificate does not cover the extra labels.
    if (endpoint.protocol === "https:" && bucket.includes("."))
      return "A bucket name with dots needs path-style requests over HTTPS";
  }
  const prefix = target.prefix;
  if (prefix.length > 512) return "The prefix is too long";
  if (prefix.startsWith("/")) return "The prefix must not start with /";
  if (prefix !== "" && !prefix.endsWith("/")) return "The prefix must end with /";
  if (
    !prefix.isWellFormed() ||
    hasControl(prefix) ||
    prefix.split("/").some((segment) => segment === "." || segment === "..")
  )
    return "The prefix contains characters S3 keys cannot use";
  if (!/^[a-z0-9-]{1,32}$/.test(target.region)) return "The region is not valid";
  if (!/^[!-~]{1,256}$/.test(target.accessKeyId) || /[/,]/.test(target.accessKeyId))
    return "The access key ID is not valid";
  if (!/^[!-~]{1,256}$/.test(target.secretAccessKey)) return "The secret access key is not valid";
  return null;
}

/** Parts of `base` bytes, grown in whole MiB when `size` would need more than 9,000 of them. */
export function partSizeFor(size: number, base = DEFAULT_PART_BYTES): number {
  return Math.ceil(size / base) <= MAX_PARTS ? base : Math.ceil(size / MAX_PARTS / MiB) * MiB;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, (match, ref: string) => {
    if (!ref.startsWith("#")) return XML_ENTITIES[ref] ?? match;
    const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
      ? match
      : String.fromCodePoint(code);
  });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The raw contents of every `<tag>…</tag>`; S3 never nests an element inside one of its name. */
function elements(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

function textOf(xml: string, tag: string): string | null {
  const [inner] = elements(xml, tag);
  return inner === undefined ? null : decodeXml(inner);
}

/** S3's `<Error><Code>`, when it is a plain identifier. */
function errorCode(xml: string): string | null {
  const [error] = elements(xml, "Error");
  const code = error === undefined ? null : textOf(error, "Code")?.trim();
  return code && /^[A-Za-z0-9._-]{1,64}$/.test(code) ? code : null;
}

function statusError(status: number, text: string): S3Error {
  const code = errorCode(text) ?? `http-${status}`;
  return new S3Error(code, `S3 answered ${status} (${code})`, status);
}

function retryable(error: unknown): boolean {
  if (!(error instanceof S3Error)) return false;
  if (error.code === "network" || error.code === "timeout" || RETRY_CODES.has(error.code))
    return true;
  return error.status !== null && (error.status >= 500 || error.status === 429);
}

const cancelled = () => new S3Error("aborted", "The transfer was cancelled");
const sizeMismatch = () => new S3Error("size-mismatch", "The data did not match its expected size");

async function readText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new S3Error("too-large", "S3 answer too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Re-chunks `body` into parts of `partSize` bytes (the last one shorter), holding one part at a
 * time, and checks it yields exactly `size` bytes.
 */
async function* partsOf(
  body: AsyncIterable<Uint8Array>,
  size: number,
  partSize: number,
): AsyncGenerator<Uint8Array> {
  let read = 0;
  let emitted = 0;
  let part = new Uint8Array(Math.min(partSize, size));
  let filled = 0;
  for await (const chunk of body) {
    read += chunk.byteLength;
    if (read > size) throw sizeMismatch();
    for (let offset = 0; offset < chunk.byteLength;) {
      const count = Math.min(part.byteLength - filled, chunk.byteLength - offset);
      part.set(chunk.subarray(offset, offset + count), filled);
      filled += count;
      offset += count;
      if (filled === part.byteLength) {
        yield part;
        emitted += part.byteLength;
        part = new Uint8Array(Math.min(partSize, size - emitted));
        filled = 0;
      }
    }
  }
  if (read !== size) throw sizeMismatch();
}

interface S3Request {
  method: "GET" | "PUT" | "POST" | "DELETE";
  /** The full object key; absent for bucket requests. */
  key?: string;
  query?: ReadonlyArray<readonly [string, string]>;
  headers?: Record<string, string>;
  body?: Uint8Array;
  signal?: AbortSignal | undefined;
}

interface S3Answer {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * A small S3 client for off-site backup copies: SigV4 with hashed payloads, single or multipart
 * uploads of a stream of known size, listing and deletion under one prefix.
 */
export class S3Client {
  readonly #target: S3Target;
  readonly #origin: string;
  readonly #host: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #partSize: number;
  readonly #timeoutMs: number;
  readonly #retryDelayMs: number;

  constructor(target: S3Target, options: S3ClientOptions = {}) {
    const problem = validateS3Target(target);
    if (problem) throw new S3Error("invalid-target", problem);
    this.#target = { ...target };
    const endpoint = new URL(target.endpoint);
    this.#host = target.pathStyle ? endpoint.host : `${target.bucket}.${endpoint.host}`;
    this.#origin = `${endpoint.protocol}//${this.#host}`;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#partSize = Math.max(1, Math.floor(options.partSize ?? DEFAULT_PART_BYTES));
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#retryDelayMs = options.retryDelayMs ?? 500;
  }

  /** Proves the credentials and bucket work by listing at most one key under the prefix. */
  async check(signal?: AbortSignal): Promise<void> {
    const answer = await this.#request({
      method: "GET",
      query: [
        ["list-type", "2"],
        ["max-keys", "1"],
        ["prefix", this.#target.prefix],
      ],
      signal,
    });
    if (!/<ListBucketResult[\s>]/.test(answer.text))
      throw new S3Error("bad-response", "The endpoint did not answer like S3", answer.status);
  }

  /** Every object directly under the prefix. */
  async list(signal?: AbortSignal): Promise<S3Object[]> {
    const prefix = this.#target.prefix;
    const objects: S3Object[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: Array<[string, string]> = [
        ["list-type", "2"],
        ["delimiter", "/"],
        ["prefix", prefix],
      ];
      if (token !== null) query.push(["continuation-token", token]);
      const answer = await this.#retry(
        () => this.#request({ method: "GET", query, signal }),
        signal,
      );
      if (!/<ListBucketResult[\s>]/.test(answer.text))
        throw new S3Error("bad-response", "The endpoint did not answer like S3", answer.status);
      for (const entry of elements(answer.text, "Contents")) {
        const key = textOf(entry, "Key");
        if (key === null || !key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length);
        if (!name || name.includes("/")) continue;
        const size = Number(textOf(entry, "Size"));
        const modified = Date.parse(textOf(entry, "LastModified") ?? "");
        objects.push({
          name,
          size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
          lastModified: Number.isFinite(modified) ? modified : 0,
        });
      }
      if (textOf(answer.text, "IsTruncated")?.trim() !== "true") return objects;
      const next = textOf(answer.text, "NextContinuationToken");
      if (!next || next === token)
        throw new S3Error("bad-response", "The S3 listing did not continue", answer.status);
      token = next;
    }
    throw new S3Error("bad-response", "The S3 listing did not end");
  }

  /**
   * Uploads `size` bytes from `body`: one PUT up to the part size, a multipart upload beyond it
   * (aborted again when anything fails). Parts and PUTs are retried on network errors, 5xx and 429.
   */
  async put(
    name: string,
    body: AsyncIterable<Uint8Array>,
    size: number,
    options: S3PutOptions = {},
  ): Promise<void> {
    const key = this.#key(name);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES)
      throw new S3Error("invalid-size", "The object size is not valid");
    const { signal } = options;
    const contentType = options.contentType ?? "application/octet-stream";
    if (signal?.aborted) throw cancelled();
    if (size <= this.#partSize) {
      let data: Uint8Array = EMPTY;
      for await (const part of partsOf(body, size, Math.max(size, 1))) data = part;
      await this.#retry(
        () =>
          this.#request({
            method: "PUT",
            key,
            headers: { "content-type": contentType },
            body: data,
            signal,
          }),
        signal,
      );
      options.onProgress?.(size);
      return;
    }
    const partSize = partSizeFor(size, this.#partSize);
    const created = await this.#request({
      method: "POST",
      key,
      query: [["uploads", ""]],
      headers: { "content-type": contentType },
      signal,
    });
    const uploadId = textOf(created.text, "UploadId");
    if (!uploadId) throw new S3Error("bad-response", "S3 did not start the upload", created.status);
    try {
      const etags: string[] = [];
      let sent = 0;
      for await (const part of partsOf(body, size, partSize)) {
        if (signal?.aborted) throw cancelled();
        const query = [
          ["partNumber", String(etags.length + 1)],
          ["uploadId", uploadId],
        ] as const;
        const answer = await this.#retry(
          () => this.#request({ method: "PUT", key, query, body: part, signal }),
          signal,
        );
        const etag = answer.headers.get("etag");
        if (!etag)
          throw new S3Error("bad-response", "S3 did not acknowledge a part", answer.status);
        etags.push(etag);
        sent += part.byteLength;
        options.onProgress?.(sent);
      }
      await this.#complete(key, uploadId, etags, signal);
    } catch (error) {
      // Without the caller's signal: it may be the reason for stopping.
      await this.#request({ method: "DELETE", key, query: [["uploadId", uploadId]] }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  /** Removes one object; one that is already gone is fine. */
  async delete(name: string, signal?: AbortSignal): Promise<void> {
    const key = this.#key(name);
    try {
      await this.#retry(() => this.#request({ method: "DELETE", key, signal }), signal);
    } catch (error) {
      if (error instanceof S3Error && error.status === 404 && error.code !== "NoSuchBucket") return;
      throw error;
    }
  }

  async #complete(
    key: string,
    uploadId: string,
    etags: string[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const parts = etags
      .map(
        (etag, index) =>
          `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
      )
      .join("");
    const body = new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts}</CompleteMultipartUpload>`,
    );
    await this.#retry(async () => {
      const answer = await this.#request({
        method: "POST",
        key,
        query: [["uploadId", uploadId]],
        headers: { "content-type": "application/xml" },
        body,
        signal,
      });
      // S3 answers 200 before it finishes and reports a late failure in the body.
      if (/<Error[\s>]/.test(answer.text)) {
        const code = errorCode(answer.text) ?? "bad-response";
        throw new S3Error(code, `S3 could not finish the upload (${code})`, answer.status);
      }
    }, signal);
  }

  /** The object key for a name directly under the prefix. */
  #key(name: string): string {
    const key = this.#target.prefix + name;
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      !name.isWellFormed() ||
      hasControl(name) ||
      Buffer.byteLength(key) > 1024
    )
      throw new S3Error("invalid-name", "Not a valid object name");
    return key;
  }

  async #retry<T>(attempt: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    for (let tries = 1; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        if (tries >= ATTEMPTS || !retryable(error) || signal?.aborted) throw error;
        try {
          await sleep(this.#retryDelayMs * 2 ** (tries - 1), undefined, signal ? { signal } : {});
        } catch {
          throw cancelled();
        }
      }
    }
  }

  async #request(input: S3Request): Promise<S3Answer> {
    const { bucket, region, accessKeyId, secretAccessKey, pathStyle } = this.#target;
    const key = input.key ?? null;
    const path = pathStyle ? `/${bucket}${key === null ? "" : `/${key}`}` : `/${key ?? ""}`;
    const query = input.query ?? [];
    const search = canonicalQuery(query);
    const body = input.body ?? EMPTY;
    const payloadHash = sha256Hex(body);
    const headers: Record<string, string> = {
      ...input.headers,
      host: this.#host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": new Date(this.#now())
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z")
        .replace(/[-:]/g, ""),
    };
    const { authorization } = signV4({
      method: input.method,
      path,
      query,
      headers,
      payloadHash,
      region,
      service: "s3",
      accessKeyId,
      secretAccessKey,
    });
    // fetch sets Host itself, from the same URL.
    const { host: _host, ...sent } = headers;
    const timeout = AbortSignal.timeout(
      this.#timeoutMs + Math.ceil((body.byteLength / SLOWEST_UPLOAD_BYTES_PER_SECOND) * 1000),
    );
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    try {
      const response = await this.#fetch(
        `${this.#origin}${canonicalPath(path)}${search ? `?${search}` : ""}`,
        {
          method: input.method,
          headers: { ...sent, authorization },
          body: input.method === "GET" || input.method === "DELETE" ? null : body,
          redirect: "manual",
          signal,
        },
      );
      const text = await readText(response, MAX_ANSWER_BYTES);
      if (response.status < 200 || response.status >= 300) throw statusError(response.status, text);
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (error instanceof S3Error) throw error;
      if (input.signal?.aborted) throw cancelled();
      if (timeout.aborted) throw new S3Error("timeout", "S3 did not answer in time");
      throw new S3Error("network", "S3 could not be reached");
    }
  }
}
