import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DRIVE_FOLDER_MIME, DRIVE_SCOPE } from "@everyos/shared";
import type { GoogleEndpoints } from "./google-http.ts";

/*
 * A small stand-in for Google's OAuth and Drive v3 endpoints, for tests and development only:
 * consent is approved at once, files live in memory.
 */

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer | null;
  trashed: boolean;
  shared: boolean;
  modifiedTime: string;
}

export interface FakeGoogle {
  endpoints: GoogleEndpoints;
  files: Map<string, FakeFile>;
  rootId: string;
  /** Adds a file or folder; returns its id. */
  add(file: {
    name: string;
    parent?: string | undefined;
    mimeType?: string;
    content?: string | Buffer;
    shared?: boolean;
  }): string;
  /** Makes refresh tokens invalid (revoked or expired). */
  revokeAll(): void;
  close(): Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const rootId = "0AFAKEROOTxxxxxxxxxxxxxxxx";
  const files = new Map<string, FakeFile>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  const uploads = new Map<
    string,
    { name: string; parents: string[]; length: number; received: Buffer[]; size: number }
  >();
  let next = 1;
  const newId = () => `fake${String(next++).padStart(12, "0")}xyz`;
  const add: FakeGoogle["add"] = (file) => {
    const id = newId();
    files.set(id, {
      id,
      name: file.name,
      mimeType:
        file.mimeType ??
        (file.content === undefined ? DRIVE_FOLDER_MIME : "application/octet-stream"),
      // Files shared with the person are in nobody's folder of theirs.
      parents: file.shared
        ? []
        : [file.parent === undefined || file.parent === "root" ? rootId : file.parent],
      content: file.content === undefined ? null : Buffer.from(file.content),
      trashed: false,
      shared: file.shared ?? false,
      modifiedTime: new Date(1_790_000_000_000).toISOString(),
    });
    return id;
  };
  const view = (file: FakeFile) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parents: file.parents,
    modifiedTime: file.modifiedTime,
    capabilities: { canEdit: true },
    ...(file.content && !file.mimeType.startsWith("application/vnd.google-apps.")
      ? { size: String(file.content.length) }
      : {}),
  });
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const send = (response: ServerResponse, status: number, value: unknown, headers = {}) => {
    response.writeHead(status, { "Content-Type": "application/json", ...headers });
    response.end(JSON.stringify(value));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const origin = `http://${request.headers.host}`;
    // Consent: approved at once, back to the app with a code.
    if (url.pathname === "/o/oauth2/v2/auth") {
      const code = randomBytes(12).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
      });
      const target = new URL(url.searchParams.get("redirect_uri")!);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      target.searchParams.set("scope", DRIVE_SCOPE);
      response.writeHead(302, { Location: target.toString() });
      response.end();
      return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams((await body(request)).toString());
      if (form.get("grant_type") === "authorization_code") {
        const consent = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (
          !consent ||
          consent.redirectUri !== form.get("redirect_uri") ||
          createHash("sha256").update(verifier).digest("base64url") !== consent.challenge
        )
          return send(response, 400, { error: "invalid_grant" });
        const refresh = `refresh-${randomBytes(8).toString("hex")}`;
        const access = `access-${randomBytes(8).toString("hex")}`;
        refreshTokens.add(refresh);
        accessTokens.add(access);
        return send(response, 200, {
          access_token: access,
          refresh_token: refresh,
          expires_in: 3599,
          scope: DRIVE_SCOPE,
          token_type: "Bearer",
        });
      }
      if (!refreshTokens.has(form.get("refresh_token") ?? ""))
        return send(response, 400, { error: "invalid_grant" });
      const access = `access-${randomBytes(8).toString("hex")}`;
      accessTokens.add(access);
      return send(response, 200, { access_token: access, expires_in: 3599, token_type: "Bearer" });
    }
    if (url.pathname === "/revoke") {
      refreshTokens.delete(
        new URLSearchParams((await body(request)).toString()).get("token") ?? "",
      );
      return send(response, 200, {});
    }
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!accessTokens.has(token))
      return send(response, 401, { error: { code: 401, status: "UNAUTHENTICATED" } });
    if (url.pathname === "/drive/v3/about")
      return send(response, 200, {
        user: { emailAddress: "owner@example.com", displayName: "Owner" },
        storageQuota: { usage: "1073741824", limit: "16106127360" },
      });
    if (url.pathname === "/upload/drive/v3/files" && request.method === "POST") {
      const metadata = JSON.parse((await body(request)).toString()) as {
        name: string;
        parents: string[];
      };
      const uploadId = randomBytes(6).toString("hex");
      uploads.set(uploadId, {
        name: metadata.name,
        parents: metadata.parents.map((parent) => (parent === "root" ? rootId : parent)),
        length: Number(request.headers["x-upload-content-length"]),
        received: [],
        size: 0,
      });
      response.writeHead(200, {
        Location: `${origin}/upload/drive/v3/files?upload_id=${uploadId}`,
      });
      response.end();
      return;
    }
    if (url.pathname === "/upload/drive/v3/files" && request.method === "PUT") {
      const pending = uploads.get(url.searchParams.get("upload_id") ?? "");
      const chunk = await body(request);
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers["content-range"] ?? "");
      if (!pending || (range && Number(range[1]) !== pending.size))
        return send(response, 400, { error: { errors: [{ reason: "badContent" }] } });
      pending.received.push(chunk);
      pending.size += chunk.length;
      // Chunked uploads: Google confirms what it has until the last byte arrives.
      if (pending.size < pending.length) {
        response.writeHead(308, { Range: `bytes=0-${pending.size - 1}` });
        response.end();
        return;
      }
      const content = Buffer.concat(pending.received);
      if (content.length !== pending.length)
        return send(response, 400, { error: { errors: [{ reason: "badContent" }] } });
      uploads.delete(url.searchParams.get("upload_id")!);
      const id = add({ name: pending.name, parent: pending.parents[0], content });
      return send(response, 200, view(files.get(id)!));
    }
    if (url.pathname === "/drive/v3/files" && request.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const inParent = /^'([^']+)' in parents/.exec(q)?.[1];
      const parent = inParent === "root" ? rootId : inParent;
      const named = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      const kind = /mimeType (!?=) '/.exec(q)?.[1];
      const list = [...files.values()].filter(
        (file) =>
          !file.trashed &&
          (q.startsWith("sharedWithMe") ? file.shared : file.parents.includes(parent ?? "")) &&
          (named === undefined || file.name === named) &&
          (kind === undefined || (file.mimeType === DRIVE_FOLDER_MIME) === (kind === "=")),
      );
      list.sort(
        (a, b) =>
          Number(b.mimeType === DRIVE_FOLDER_MIME) - Number(a.mimeType === DRIVE_FOLDER_MIME) ||
          a.name.localeCompare(b.name),
      );
      return send(response, 200, { files: list.map(view) });
    }
    if (url.pathname === "/drive/v3/files" && request.method === "POST") {
      const metadata = JSON.parse((await body(request)).toString()) as {
        name: string;
        parents: string[];
        mimeType: string;
      };
      const id = add({
        name: metadata.name,
        parent: metadata.parents[0],
        mimeType: metadata.mimeType,
      });
      return send(response, 200, view(files.get(id)!));
    }
    const match = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(url.pathname);
    if (match) {
      const id = match[1] === "root" ? rootId : decodeURIComponent(match[1]!);
      if (id === rootId && request.method === "GET") return send(response, 200, { id: rootId });
      const file = files.get(id);
      if (!file || file.trashed)
        return send(response, 404, { error: { errors: [{ reason: "notFound" }] } });
      if (request.method === "DELETE") {
        files.delete(id);
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "PATCH") {
        const patch = JSON.parse((await body(request)).toString()) as {
          name?: string;
          trashed?: boolean;
        };
        if (patch.name !== undefined) file.name = patch.name;
        if (patch.trashed !== undefined) file.trashed = patch.trashed;
        return send(response, 200, view(file));
      }
      if (match[2] || url.searchParams.get("alt") === "media") {
        const content = match[2] ? Buffer.from(`exported:${file.name}`) : file.content;
        if (!content)
          return send(response, 403, { error: { errors: [{ reason: "fileNotDownloadable" }] } });
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          // Exports come without a length, like Google's chunked answers.
          ...(match[2] ? {} : { "Content-Length": String(content.length) }),
        });
        response.end(content);
        return;
      }
      return send(response, 200, view(file));
    }
    send(response, 404, { error: { errors: [{ reason: "notFound" }] } });
  };
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoints: { oauth: origin, api: origin, accounts: origin },
    files,
    rootId,
    add,
    revokeAll: () => {
      refreshTokens.clear();
      accessTokens.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
