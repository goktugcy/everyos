import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  S3Client,
  S3Error,
  canonicalPath,
  canonicalQuery,
  partSizeFor,
  signV4,
  validateS3Target,
  type S3ClientOptions,
  type S3Target,
} from "./s3-client.ts";

const MiB = 1024 * 1024;
const BUCKET = "backups";
const ACCESS_KEY = "AKIDEVERYOSTEST";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEVERYOSKEY";
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const md5 = (data: Buffer) => createHash("md5").update(data).digest("hex");

/** Keys as S3 writes them: entities, with a numeric reference for everything beyond ASCII. */
function xml(value: string): string {
  return [...value]
    .map((char) => {
      if (char === "&") return "&amp;";
      if (char === "<") return "&lt;";
      if (char === ">") return "&gt;";
      if (char === '"') return "&quot;";
      if (char === "'") return "&#39;";
      const code = char.codePointAt(0) ?? 0;
      return code > 0x7e ? `&#x${code.toString(16)};` : char;
    })
    .join("");
}

function errorXml(code: string, message = "Refused"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${xml(message)}</Message><RequestId>1</RequestId></Error>`;
}

interface FakeRequest {
  method: string;
  key: string;
  query: Map<string, string>;
  bytes: number;
  contentLength: string | undefined;
  contentType: string | undefined;
  amzDate: string | undefined;
  authorization: string;
}

type Intercept = (request: FakeRequest) => { status: number; body?: string } | "hang" | null;

interface Fake {
  url: string;
  port: number;
  objects: Map<string, { body: Buffer; modified: number; contentType: string | undefined }>;
  uploads: Map<string, { key: string; parts: Map<number, Buffer> }>;
  aborted: string[];
  log: FakeRequest[];
  intercept: Intercept | null;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function send(
  response: ServerResponse,
  status: number,
  body = "",
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/xml", ...headers });
  response.end(body);
}

/** Rejects anything whose SigV4 signature does not recompute from the request as received. */
function verify(request: IncomingMessage, body: Buffer): string | null {
  const [rawPath = "", rawQuery = ""] = (request.url ?? "").split("?");
  const path = rawPath.split("/").map(decodeURIComponent).join("/");
  const query = rawQuery
    ? rawQuery.split("&").map((pair): [string, string] => {
        const at = pair.indexOf("=");
        return at < 0
          ? [decodeURIComponent(pair), ""]
          : [decodeURIComponent(pair.slice(0, at)), decodeURIComponent(pair.slice(at + 1))];
      })
    : [];
  if (rawPath !== canonicalPath(path) || rawQuery !== canonicalQuery(query))
    return "SignatureDoesNotMatch";
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([a-z0-9-]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      request.headers.authorization ?? "",
    );
  if (!match) return "AccessDenied";
  const [, accessKey, day, region, signed = "", signature] = match;
  if (accessKey !== ACCESS_KEY) return "InvalidAccessKeyId";
  const names = signed.split(";");
  if (!["host", "x-amz-content-sha256", "x-amz-date"].every((name) => names.includes(name)))
    return "AccessDenied";
  const headers = Object.fromEntries(
    names.map((name) => [name, String(request.headers[name] ?? "")]),
  );
  if (headers["x-amz-content-sha256"] !== sha256(body)) return "XAmzContentSHA256Mismatch";
  if (headers["x-amz-date"]?.slice(0, 8) !== day || region !== "us-east-1")
    return "AuthorizationHeaderMalformed";
  const expected = signV4({
    method: request.method ?? "",
    path,
    query,
    headers,
    payloadHash: sha256(body),
    region,
    service: "s3",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  });
  return expected.signature === signature ? null : "SignatureDoesNotMatch";
}

function list(fake: Fake, query: Map<string, string>, response: ServerResponse): void {
  const prefix = query.get("prefix") ?? "";
  const delimiter = query.get("delimiter") ?? "";
  // Pages of two keys, so a client has to follow continuation tokens.
  const max = Math.min(Number(query.get("max-keys") ?? 1000), 2);
  const token = query.get("continuation-token");
  const after = token ? Buffer.from(token.slice("t+/".length), "base64").toString() : "";
  const entries = new Map<string, "key" | "prefix">();
  for (const key of fake.objects.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const cut = delimiter ? rest.indexOf(delimiter) : -1;
    if (cut < 0) entries.set(key, "key");
    else entries.set(prefix + rest.slice(0, cut + delimiter.length), "prefix");
  }
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1)).filter(([key]) => key > after);
  const page = sorted.slice(0, max);
  const truncated = sorted.length > page.length;
  const last = page.at(-1)?.[0] ?? "";
  const items = page
    .map(([key, kind]) => {
      if (kind === "prefix") return `<CommonPrefixes><Prefix>${xml(key)}</Prefix></CommonPrefixes>`;
      const object = fake.objects.get(key)!;
      return `<Contents><Key>${xml(key)}</Key><LastModified>${new Date(object.modified).toISOString()}</LastModified><ETag>&quot;${md5(object.body)}&quot;</ETag><Size>${object.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
    })
    .join("");
  send(
    response,
    200,
    `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${BUCKET}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><Delimiter>${xml(delimiter)}</Delimiter><IsTruncated>${truncated}</IsTruncated>${
      truncated
        ? `<NextContinuationToken>t+/${Buffer.from(last).toString("base64")}</NextContinuationToken>`
        : ""
    }${items}</ListBucketResult>`,
  );
}

async function handle(fake: Fake, request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const [rawPath = "", rawQuery = ""] = (request.url ?? "").split("?");
  const [, bucket = "", ...rest] = rawPath.split("/").map(decodeURIComponent);
  const key = rest.join("/");
  const query = new Map(new URLSearchParams(rawQuery));
  const method = request.method ?? "";
  const entry: FakeRequest = {
    method,
    key,
    query,
    bytes: body.length,
    contentLength: request.headers["content-length"],
    contentType: request.headers["content-type"],
    amzDate: request.headers["x-amz-date"] as string | undefined,
    authorization: request.headers.authorization ?? "",
  };
  fake.log.push(entry);
  const refused = verify(request, body);
  if (refused) return send(response, 403, errorXml(refused));
  const intercepted = fake.intercept?.(entry) ?? null;
  if (intercepted === "hang") return;
  if (intercepted) return send(response, intercepted.status, intercepted.body ?? "");
  if (bucket !== BUCKET) return send(response, 404, errorXml("NoSuchBucket"));

  const uploadId = query.get("uploadId");
  const upload = uploadId === undefined ? undefined : fake.uploads.get(uploadId);
  if (uploadId !== undefined && !upload) return send(response, 404, errorXml("NoSuchUpload"));
  if (method === "GET" && !key && query.get("list-type") === "2")
    return list(fake, query, response);
  if (method === "PUT" && upload) {
    if (entry.contentLength !== String(body.length))
      return send(response, 400, errorXml("MissingContentLength"));
    upload.parts.set(Number(query.get("partNumber")), body);
    return send(response, 200, "", { etag: `"${md5(body)}"` });
  }
  if (method === "PUT" && key) {
    fake.objects.set(key, { body, modified: Date.now(), contentType: entry.contentType });
    return send(response, 200, "", { etag: `"${md5(body)}"` });
  }
  if (method === "POST" && query.has("uploads")) {
    const id = `2~${randomBytes(8).toString("hex")}._-`;
    fake.uploads.set(id, { key, parts: new Map() });
    return send(
      response,
      200,
      `<?xml version="1.0" encoding="UTF-8"?>\n<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${xml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    );
  }
  if (method === "POST" && upload && uploadId) {
    const listed = [
      ...body
        .toString()
        .matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag><\/Part>/g),
    ];
    const parts = listed.map(([, number, etag]) => ({ number: Number(number), etag }));
    const valid =
      parts.length === upload.parts.size &&
      parts.every(
        ({ number, etag }, index) =>
          number === index + 1 && etag === `"${md5(upload.parts.get(number) ?? Buffer.alloc(0))}"`,
      );
    if (!valid) return send(response, 400, errorXml("InvalidPart"));
    fake.objects.set(key, {
      body: Buffer.concat(parts.map(({ number }) => upload.parts.get(number)!)),
      modified: Date.now(),
      contentType: undefined,
    });
    fake.uploads.delete(uploadId);
    return send(
      response,
      200,
      `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${xml(key)}</Key><ETag>&quot;x-${parts.length}&quot;</ETag></CompleteMultipartUploadResult>`,
    );
  }
  if (method === "DELETE" && upload && uploadId) {
    fake.uploads.delete(uploadId);
    fake.aborted.push(uploadId);
    return send(response, 204);
  }
  if (method === "DELETE" && key) {
    fake.objects.delete(key);
    return send(response, 204);
  }
  send(response, 400, errorXml("InvalidRequest"));
}

async function startFake(): Promise<Fake> {
  const fake: Fake = {
    url: "",
    port: 0,
    objects: new Map(),
    uploads: new Map(),
    aborted: [],
    log: [],
    intercept: null,
  };
  const server = createServer((request, response) => {
    handle(fake, request, response).catch(() => send(response, 500, errorXml("InternalError")));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  return fake;
}

function target(fake: Fake, change: Partial<S3Target> = {}): S3Target {
  return {
    endpoint: fake.url,
    region: "us-east-1",
    bucket: BUCKET,
    prefix: "everyos/",
    pathStyle: true,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    ...change,
  };
}

function clientFor(fake: Fake, change: Partial<S3Target> = {}, options: S3ClientOptions = {}) {
  return new S3Client(target(fake, change), { retryDelayMs: 1, ...options });
}

/** Yields `data` in uneven chunk sizes, across event loop turns like a file stream. */
async function* chunked(data: Buffer, sizes = [7, 333, 1001, 64, 2048]): AsyncGenerator<Buffer> {
  let offset = 0;
  for (let index = 0; offset < data.length; index++) {
    const size = sizes[index % sizes.length] ?? 1;
    await new Promise((resolve) => setImmediate(resolve));
    yield data.subarray(offset, offset + size);
    offset += size;
  }
}

async function failure(promise: Promise<unknown>): Promise<S3Error> {
  const error = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(S3Error);
  const s3 = error as S3Error;
  for (const text of [s3.message, String(s3), JSON.stringify(s3), s3.stack ?? ""]) {
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("Signature=");
    expect(text).not.toContain("AWS4-HMAC-SHA256");
  }
  return s3;
}

describe("signV4", () => {
  it("matches the AWS Signature Version 4 documentation example", () => {
    const signed = signV4({
      method: "GET",
      path: "/",
      query: [
        ["Action", "ListUsers"],
        ["Version", "2010-05-08"],
      ],
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        host: "iam.amazonaws.com",
        "x-amz-date": "20150830T123600Z",
      },
      payloadHash: sha256(""),
      region: "us-east-1",
      service: "iam",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    });
    expect(signed.signature).toBe(
      "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(signed.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("encodes S3 paths and query strings the AWS way", () => {
    expect(canonicalPath("/b/a b+c/ğ*~.-_(x)!'")).toBe("/b/a%20b%2Bc/%C4%9F%2A~.-_%28x%29%21%27");
    expect(canonicalPath("/")).toBe("/");
    expect(
      canonicalQuery([
        ["prefix", ""],
        ["max-keys", "1"],
        ["list-type", "2"],
      ]),
    ).toBe("list-type=2&max-keys=1&prefix=");
    expect(
      canonicalQuery([
        ["b", "2"],
        ["a", "x y/="],
        ["a", "1"],
      ]),
    ).toBe("a=1&a=x%20y%2F%3D&b=2");
  });
});

describe("validateS3Target", () => {
  const base: S3Target = {
    endpoint: "https://s3.eu-central-1.amazonaws.com",
    region: "eu-central-1",
    bucket: "my-backups",
    prefix: "everyos/",
    pathStyle: false,
    accessKeyId: "AKIA0000",
    secretAccessKey: "secret/key+value",
  };

  it("accepts AWS, R2 and MinIO targets", () => {
    expect(validateS3Target(base)).toBeNull();
    expect(
      validateS3Target({
        ...base,
        endpoint: "https://0123abcd.r2.cloudflarestorage.com/",
        region: "auto",
        prefix: "",
      }),
    ).toBeNull();
    expect(
      validateS3Target({
        ...base,
        endpoint: "http://192.168.1.10:9000",
        region: "us-east-1",
        bucket: "nas.backups",
        pathStyle: true,
      }),
    ).toBeNull();
  });

  it("explains what is wrong", () => {
    const wrong: Array<Partial<S3Target>> = [
      { endpoint: "s3.amazonaws.com" },
      { endpoint: "ftp://s3.amazonaws.com" },
      { endpoint: "https://user:pass@s3.amazonaws.com" },
      { endpoint: "https://s3.amazonaws.com/?x=1" },
      { endpoint: "https://s3.amazonaws.com/#x" },
      { endpoint: "https://s3.amazonaws.com/bucket" },
      { bucket: "ab" },
      { bucket: "My-Backups" },
      { bucket: "-backups" },
      { bucket: "backups-" },
      { bucket: "my..backups" },
      { bucket: "192.168.1.10" },
      { bucket: "a".repeat(64) },
      { bucket: "my.backups" },
      { endpoint: "http://10.0.0.2:9000" },
      { prefix: "/everyos/" },
      { prefix: "everyos" },
      { prefix: `${"a".repeat(512)}/` },
      { prefix: "everyos/../" },
      { region: "EU" },
      { region: "" },
      { accessKeyId: "" },
      { accessKeyId: "AKIA 0000" },
      { secretAccessKey: "" },
      { secretAccessKey: "x".repeat(257) },
    ];
    for (const change of wrong)
      expect(validateS3Target({ ...base, ...change })).toEqual(expect.any(String));
  });

  it("is enforced by the client", () => {
    expect(() => new S3Client({ ...base, bucket: "A" })).toThrow(S3Error);
    expect(() => new S3Client({ ...base, bucket: "A" })).toThrow("The bucket name is not valid");
  });
});

describe("partSizeFor", () => {
  it("keeps 16 MiB parts and grows them in whole MiB beyond 9,000 parts", () => {
    expect(partSizeFor(10 * 1024 * MiB)).toBe(16 * MiB);
    expect(partSizeFor(9_000 * 16 * MiB)).toBe(16 * MiB);
    expect(partSizeFor(9_000 * 16 * MiB + 1)).toBe(17 * MiB);
    const tebibyte = 1024 * 1024 * MiB;
    expect(partSizeFor(tebibyte)).toBe(117 * MiB);
    expect(Math.ceil(tebibyte / partSizeFor(tebibyte))).toBeLessThanOrEqual(9_000);
  });
});

describe("S3Client", () => {
  it("checks the credentials and bucket by listing one key under the prefix", async () => {
    const fake = await startFake();
    const now = Date.UTC(2026, 9, 18, 9, 30, 5);
    await clientFor(fake, {}, { now: () => now }).check();
    expect(fake.log).toHaveLength(1);
    const [request] = fake.log;
    expect(request?.method).toBe("GET");
    expect(Object.fromEntries(request?.query ?? [])).toEqual({
      "list-type": "2",
      "max-keys": "1",
      prefix: "everyos/",
    });
    expect(request?.amzDate).toBe("20261018T093005Z");
  });

  it("surfaces S3's error codes without credentials in the message", async () => {
    const fake = await startFake();
    const signature = await failure(clientFor(fake, { secretAccessKey: "not-the-secret" }).check());
    expect(signature).toMatchObject({ code: "SignatureDoesNotMatch", status: 403 });
    const accessKey = await failure(clientFor(fake, { accessKeyId: "AKIDWRONG" }).check());
    expect(accessKey).toMatchObject({ code: "InvalidAccessKeyId", status: 403 });
    const bucket = await failure(clientFor(fake, { bucket: "elsewhere" }).check());
    expect(bucket).toMatchObject({ code: "NoSuchBucket", status: 404 });
    // A server echoing the request back in its message changes nothing.
    fake.intercept = (request) => ({
      status: 403,
      body: errorXml("AccessDenied", `${request.authorization} ${SECRET_KEY}`),
    });
    const denied = await failure(clientFor(fake).check());
    expect(denied).toMatchObject({ code: "AccessDenied", status: 403 });
    fake.intercept = () => ({ status: 502, body: "<html>Bad gateway</html>" });
    expect(await failure(clientFor(fake).check())).toMatchObject({
      code: "http-502",
      status: 502,
    });
  });

  it("uploads up to the part size with a single PUT", async () => {
    const fake = await startFake();
    const data = randomBytes(3000);
    const progress: number[] = [];
    await clientFor(fake, {}, { partSize: 4000 }).put("one.ebk", chunked(data), data.length, {
      contentType: "application/vnd.everyos.backup",
      onProgress: (sent) => progress.push(sent),
    });
    expect(fake.objects.get("everyos/one.ebk")?.body.equals(data)).toBe(true);
    expect(fake.objects.get("everyos/one.ebk")?.contentType).toBe("application/vnd.everyos.backup");
    expect(fake.log.map(({ method, query }) => [method, [...query.keys()]])).toEqual([["PUT", []]]);
    expect(progress).toEqual([3000]);

    await clientFor(fake).put("empty.ebk", chunked(Buffer.alloc(0)), 0);
    expect(fake.objects.get("everyos/empty.ebk")?.body.length).toBe(0);
  });

  it("uploads larger data in parts and completes them in order", async () => {
    const fake = await startFake();
    const data = randomBytes(3500);
    const progress: number[] = [];
    await clientFor(fake, {}, { partSize: 1000 }).put("big.ebk", chunked(data), data.length, {
      onProgress: (sent) => progress.push(sent),
    });
    expect(fake.objects.get("everyos/big.ebk")?.body.equals(data)).toBe(true);
    const parts = fake.log.filter((request) => request.query.has("partNumber"));
    expect(parts.map((part) => [part.query.get("partNumber"), part.bytes])).toEqual([
      ["1", 1000],
      ["2", 1000],
      ["3", 1000],
      ["4", 500],
    ]);
    expect(parts.every((part) => part.contentLength === String(part.bytes))).toBe(true);
    expect(fake.log.map(({ method }) => method)).toEqual([
      "POST",
      "PUT",
      "PUT",
      "PUT",
      "PUT",
      "POST",
    ]);
    expect(progress).toEqual([1000, 2000, 3000, 3500]);
    expect(fake.uploads.size).toBe(0);
    expect(fake.aborted).toEqual([]);
  });

  it("lists direct children across pages with the prefix removed", async () => {
    const fake = await startFake();
    const modified = Date.UTC(2026, 9, 1, 12);
    for (const [key, size] of [
      ["everyos/2026-10-01.ebk", 10],
      ["everyos/2026-10-02.ebk", 20],
      ["everyos/a&b <c>.ebk", 30],
      ["everyos/nested/skip.ebk", 40],
      ["everyos/zz.ebk", 50],
      ["everyos-other/x.ebk", 60],
      ["other/y.ebk", 70],
    ] as const)
      fake.objects.set(key, { body: Buffer.alloc(size), modified, contentType: undefined });
    const listed = await clientFor(fake).list();
    expect(listed).toEqual([
      { name: "2026-10-01.ebk", size: 10, lastModified: modified },
      { name: "2026-10-02.ebk", size: 20, lastModified: modified },
      { name: "a&b <c>.ebk", size: 30, lastModified: modified },
      { name: "zz.ebk", size: 50, lastModified: modified },
    ]);
    const pages = fake.log.filter((request) => request.query.get("list-type") === "2");
    expect(pages.length).toBe(3);
    expect(pages.every((page) => page.query.get("delimiter") === "/")).toBe(true);
    expect(pages[0]?.query.has("continuation-token")).toBe(false);
    expect(pages[1]?.query.get("continuation-token")).toMatch(/^t\+\//);

    expect(await clientFor(fake, { prefix: "" }).list()).toEqual([]);
  });

  it("round-trips names with spaces, unicode and plus signs", async () => {
    const fake = await startFake();
    const name = "yedek ğüşİ + 😀 'quoted' (1)*.ebk";
    const data = randomBytes(2500);
    const client = clientFor(fake, {}, { partSize: 1000 });
    await client.put(name, chunked(data), data.length);
    await client.put(`small ${name}`, chunked(data.subarray(0, 10)), 10);
    expect(fake.objects.get(`everyos/${name}`)?.body.equals(data)).toBe(true);
    expect((await client.list()).map((object) => object.name)).toEqual([`small ${name}`, name]);
    await client.delete(name);
    await client.delete(name);
    expect([...fake.objects.keys()]).toEqual([`everyos/small ${name}`]);
  });

  it("retries a part on 5xx, then aborts the upload with S3's code", async () => {
    const fake = await startFake();
    fake.intercept = (request) =>
      request.query.get("partNumber") === "2"
        ? { status: 500, body: errorXml("InternalError") }
        : null;
    const data = randomBytes(3000);
    const error = await failure(
      clientFor(fake, {}, { partSize: 1000 }).put("fail.ebk", chunked(data), data.length),
    );
    expect(error).toMatchObject({ code: "InternalError", status: 500 });
    expect(fake.log.filter((request) => request.query.get("partNumber") === "2")).toHaveLength(3);
    expect(fake.log.some((request) => request.query.get("partNumber") === "3")).toBe(false);
    expect(fake.aborted).toHaveLength(1);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
  });

  it("does not retry a refused part", async () => {
    const fake = await startFake();
    fake.intercept = (request) =>
      request.query.has("partNumber") ? { status: 403, body: errorXml("AccessDenied") } : null;
    const data = randomBytes(3000);
    const error = await failure(
      clientFor(fake, {}, { partSize: 1000 }).put("denied.ebk", chunked(data), data.length),
    );
    expect(error).toMatchObject({ code: "AccessDenied", status: 403 });
    expect(fake.log.filter((request) => request.query.has("partNumber"))).toHaveLength(1);
    expect(fake.aborted).toHaveLength(1);
  });

  it("retries a single PUT after a transient failure", async () => {
    const fake = await startFake();
    let failures = 0;
    fake.intercept = () =>
      failures++ < 2 ? { status: failures === 1 ? 503 : 429, body: errorXml("SlowDown") } : null;
    const data = randomBytes(100);
    await clientFor(fake).put("retry.ebk", chunked(data), data.length);
    expect(fake.log).toHaveLength(3);
    expect(fake.objects.get("everyos/retry.ebk")?.body.equals(data)).toBe(true);
  });

  it("refuses data that does not match its size", async () => {
    const fake = await startFake();
    const data = randomBytes(2500);
    const client = clientFor(fake, {}, { partSize: 1000 });
    const short = await failure(client.put("short.ebk", chunked(data), 3000));
    expect(short.code).toBe("size-mismatch");
    const long = await failure(client.put("long.ebk", chunked(data), 2400));
    expect(long.code).toBe("size-mismatch");
    const single = await failure(client.put("single.ebk", chunked(data.subarray(0, 10)), 20));
    expect(single.code).toBe("size-mismatch");
    expect(fake.aborted).toHaveLength(2);
    expect(fake.uploads.size).toBe(0);
    expect(fake.objects.size).toBe(0);
    expect(fake.log.some((request) => request.method === "PUT" && !request.query.size)).toBe(false);
  });

  it("surfaces an <Error> inside a 200 CompleteMultipartUpload answer", async () => {
    const fake = await startFake();
    fake.intercept = (request) =>
      request.method === "POST" && request.query.has("uploadId")
        ? { status: 200, body: `\n\n${errorXml("InvalidPart")}` }
        : null;
    const data = randomBytes(1500);
    const error = await failure(
      clientFor(fake, {}, { partSize: 1000 }).put("late.ebk", chunked(data), data.length),
    );
    expect(error).toMatchObject({ code: "InvalidPart", status: 200 });
    expect(fake.aborted).toHaveLength(1);
    expect(fake.objects.size).toBe(0);
  });

  it("aborts the multipart upload when the caller cancels", async () => {
    const fake = await startFake();
    const controller = new AbortController();
    const data = randomBytes(3000);
    const error = await failure(
      clientFor(fake, {}, { partSize: 1000 }).put("cancel.ebk", chunked(data), data.length, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    );
    expect(error.code).toBe("aborted");
    expect(fake.log.filter((request) => request.query.has("partNumber"))).toHaveLength(1);
    expect(fake.aborted).toHaveLength(1);
  });

  it("times out a request that never answers", async () => {
    const fake = await startFake();
    fake.intercept = () => "hang";
    const error = await failure(clientFor(fake, {}, { timeoutMs: 50 }).check());
    expect(error).toMatchObject({ code: "timeout", status: null });
  });

  it("reports an unreachable endpoint as a network error", async () => {
    const fake = await startFake();
    const server = servers.pop();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const error = await failure(clientFor(fake).list());
    expect(error).toMatchObject({ code: "network", status: null });
  });

  it("treats deleting a missing object as done but not a missing bucket", async () => {
    const fake = await startFake();
    fake.intercept = () => ({ status: 404, body: errorXml("NoSuchKey") });
    await clientFor(fake).delete("gone.ebk");
    fake.intercept = null;
    const error = await failure(clientFor(fake, { bucket: "elsewhere" }).delete("gone.ebk"));
    expect(error.code).toBe("NoSuchBucket");
  });

  it("refuses names that are not direct children", async () => {
    const fake = await startFake();
    const client = clientFor(fake);
    for (const name of ["", ".", "..", "a/b", "tab\there", "\ud800"])
      expect((await failure(client.delete(name))).code).toBe("invalid-name");
    expect(fake.log).toHaveLength(0);
  });
});
