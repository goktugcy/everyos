import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import {
  generatePublisherKeys,
  keyFingerprint,
  packDirectory,
  sha256Hex,
  signPackage,
} from "@everyos/app-package";
import type {
  DbQueryResult,
  DbTable,
  NetDnsResult,
  NetHttpResponse,
  NetMonitor,
  NetMonitorCheck,
  NetTlsResult,
} from "@everyos/app-sdk/protocol";
import { signRegistryIndex, type RegistryIndex } from "@everyos/app-registry";
import { createCatalogFetcher } from "@everyos/catalogs";
import type {
  ApiErrorBody,
  DesktopAppInstallationView,
  DesktopAppDbConnectionView,
  DesktopAppListing,
  DesktopAppNetworkRuleView,
  DesktopAppRegistryView,
} from "@everyos/shared";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_CSP } from "./modules/desktop-apps/runtime-routes.ts";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TestClient,
  type TestContext,
} from "./test-support.ts";
import { REQUIRE_DB_TESTS, startMysql, startPostgres } from "./test-databases.ts";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d30000000049454e44ae426082",
  "hex",
);
const registryKeys = generatePublisherKeys();
const officialKeys = generatePublisherKeys();

/** A registry served over HTTP from memory, recording what was asked of it. */
class TestRegistry {
  readonly files = new Map<string, Buffer>();
  readonly requests: Array<{ path: string; authorization: string | undefined }> = [];
  readonly server: Server;
  base = "";
  constructor() {
    this.server = createServer((req, res) => {
      this.requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
      const body = this.files.get(req.url ?? "");
      if (!body) {
        res.writeHead(404);
        res.end();
      } else res.end(body);
    });
  }
  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    this.server.close();
    await once(this.server, "close");
  }
}

interface Built {
  version: RegistryIndex["apps"][number]["versions"][number];
  bytes: Buffer;
}

async function buildApp(
  id: string,
  version: string,
  permissions: string[],
  publisherKey: string,
  overrides: Record<string, unknown> = {},
): Promise<Built> {
  const dir = await mkdtemp(join(tmpdir(), "desktop-app-"));
  const publisher = id.split(".").slice(0, -1).join(".");
  const manifest = {
    manifestVersion: 1,
    id,
    name: "Notes",
    version,
    description: "Personal notes",
    entry: "index.html",
    icon: "icon.png",
    category: "productivity",
    permissions,
    window: {
      defaultWidth: 900,
      defaultHeight: 650,
      minWidth: 420,
      minHeight: 320,
      instances: "multiple",
    },
    widgets: [],
    minEveryOS: "0.1.0",
    sdk: "^1.0.0",
    publisher: { id: publisher, name: "Publisher" },
    ...overrides,
  };
  const files: Record<string, string | Buffer> = {
    "manifest.json": JSON.stringify(manifest),
    "index.html": `<!doctype html><title>${version}</title><script type="module" src="app.js"></script>`,
    "app.js": `export const version = "${version}";`,
    "widget.html": "<!doctype html><title>widget</title>",
    "icon.png": PNG,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  const { bytes, manifest: parsed } = await packDirectory(dir);
  const digest = { appId: id, version, sha256: sha256Hex(bytes), size: bytes.length };
  return {
    bytes,
    version: {
      version,
      manifest: parsed,
      package: {
        url: `packages/${id}-${version}.eosapp`,
        size: bytes.length,
        sha256: digest.sha256,
        signature: signPackage(digest, publisherKey),
      },
      publishedAt: 1_760_000_000_000 - 1000,
    },
  };
}

function index(
  apps: Array<{ id: string; versions: Built[] }>,
  overrides: Partial<RegistryIndex> = {},
  publisher = { id: "dev.everyos", name: "EveryOS", keys: [officialKeys.publicKey] },
): RegistryIndex {
  return {
    format: "everyos-app-registry",
    schemaVersion: 1,
    registry: { id: "official", name: "EveryOS" },
    sequence: 1,
    publishedAt: 1_760_000_000_000 - 1000,
    expiresAt: 1_760_000_000_000 + 7 * 86_400_000,
    publishers: [publisher],
    apps: apps.map((app) => ({
      id: app.id,
      publisher: publisher.id,
      icon: "icons/app.png",
      screenshots: [],
      versions: app.versions.map((built) => built.version),
    })),
    revoked: [],
    ...overrides,
  };
}

let registry: TestRegistry | null = null;
afterEach(async () => {
  await registry?.stop();
  registry = null;
});

function publish(target: TestRegistry, value: RegistryIndex, builds: Built[], official = true) {
  target.files.set(
    "/index.json",
    Buffer.from(signRegistryIndex(value, registryKeys.privateKey, { official })),
  );
  target.files.set("/icons/app.png", PNG);
  for (const built of builds) target.files.set(`/${built.version.package.url}`, built.bytes);
}

async function setup(
  hooks: {
    resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  } = {},
): Promise<{
  ctx: TestContext;
  admin: TestClient;
  operator: TestClient;
  viewer: TestClient;
  registry: TestRegistry;
}> {
  registry = new TestRegistry();
  await registry.start();
  const base = registry.base;
  const ctx = await createTestContext({
    configure: (config) => {
      config.desktopApps.officialRegistry = {
        url: `${base}/index.json`,
        publicKey: registryKeys.publicKey,
      };
    },
    // The test registry listens on loopback, which production fetches refuse.
    services: {
      desktopAppFetcher: (options) => createCatalogFetcher({ ...options, allowPrivate: true }),
      ...(hooks.resolve ? { desktopAppResolve: hooks.resolve } : {}),
    },
  });
  await ctx.services.files.ensureRoots();
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  const clients: Record<string, TestClient> = {};
  for (const role of ["operator", "viewer"] as const) {
    await admin.post("/api/users", {
      username: role,
      displayName: role,
      password: STRONG_PASSWORD,
      role,
    });
    clients[role] = new TestClient(ctx, role === "operator" ? "192.0.2.10" : "192.0.2.11");
    await clients[role].login(role, STRONG_PASSWORD);
  }
  return { ctx, admin, operator: clients.operator!, viewer: clients.viewer!, registry };
}

const code = async (response: Response) => (await json<ApiErrorBody>(response)).error;
const sync = (client: TestClient) => client.post("/api/desktop-apps/registries/official/sync", {});

describe("desktop app registries", () => {
  it("syncs the official registry and lists its apps with permissions and a sniffed icon", async () => {
    const { admin, viewer, registry } = await setup();
    const notes = await buildApp(
      "dev.everyos.notes",
      "1.0.0",
      ["storage:app", "files:pick"],
      officialKeys.privateKey,
    );
    publish(registry, index([{ id: "dev.everyos.notes", versions: [notes] }]), [notes]);
    expect((await sync(viewer)).status).toBe(403);
    const synced = await json<DesktopAppRegistryView>(await sync(admin));
    expect(synced).toMatchObject({
      id: "official",
      kind: "official",
      appCount: 1,
      sequence: 1,
      lastError: null,
    });
    expect(synced.fingerprint).toBe(keyFingerprint(registryKeys.publicKey));
    const { apps } = await json<{ apps: DesktopAppListing[] }>(
      await viewer.get("/api/desktop-apps/catalog"),
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      appId: "dev.everyos.notes",
      registry: { kind: "official" },
      version: "1.0.0",
      incompatible: null,
      installed: null,
      permissions: [
        { capability: "storage:app", risk: "standard" },
        { capability: "files:pick", risk: "standard" },
      ],
    });
    const icon = await viewer.get("/api/desktop-apps/catalog/official/dev.everyos.notes/icon");
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("refuses rollbacks, foreign keys and reserved names in other registries", async () => {
    const { admin, registry } = await setup();
    const notes = await buildApp(
      "dev.everyos.notes",
      "1.0.0",
      ["storage:app"],
      officialKeys.privateKey,
    );
    publish(registry, index([{ id: "dev.everyos.notes", versions: [notes] }], { sequence: 5 }), [
      notes,
    ]);
    expect((await sync(admin)).status).toBe(200);
    publish(registry, index([{ id: "dev.everyos.notes", versions: [notes] }], { sequence: 4 }), [
      notes,
    ]);
    const rollback = await sync(admin);
    expect(rollback.status).toBe(502);
    expect((await code(rollback)).details).toEqual({ reason: "rollback" });
    const after = await json<{ registries: DesktopAppRegistryView[] }>(
      await admin.get("/api/desktop-apps/registries"),
    );
    expect(after.registries.find((r) => r.id === "official")).toMatchObject({
      sequence: 5,
      lastError: "rollback",
    });

    // A community registry cannot claim EveryOS's namespace.
    const community = new TestRegistry();
    await community.start();
    try {
      const keys = generatePublisherKeys();
      community.files.set(
        "/index.json",
        Buffer.from(
          JSON.stringify({
            payload: Buffer.from(
              JSON.stringify(index([{ id: "dev.everyos.notes", versions: [notes] }])),
            ).toString("base64"),
            signature: (await import("node:crypto"))
              .sign(
                null,
                Buffer.from(
                  JSON.stringify(index([{ id: "dev.everyos.notes", versions: [notes] }])),
                ),
                (await import("node:crypto")).createPrivateKey(keys.privateKey),
              )
              .toString("base64"),
          }),
        ),
      );
      const wrongFingerprint = await admin.post("/api/desktop-apps/registries", {
        kind: "community",
        name: "Imposter",
        url: `${community.base}/index.json`,
        publicKey: keys.publicKey,
        fingerprint: keyFingerprint(registryKeys.publicKey),
      });
      expect(wrongFingerprint.status).toBe(400);
      const created = await json<DesktopAppRegistryView>(
        await admin.post("/api/desktop-apps/registries", {
          kind: "community",
          name: "Imposter",
          url: `${community.base}/index.json`,
          publicKey: keys.publicKey,
          fingerprint: keyFingerprint(keys.publicKey),
          allowPrivate: true,
        }),
      );
      const claimed = await admin.post(`/api/desktop-apps/registries/${created.id}/sync`, {});
      expect(claimed.status).toBe(502);
      expect((await code(claimed)).details).toEqual({ reason: "invalid-index" });
    } finally {
      await community.stop();
    }
  });

  it("sends a private registry's token only to the registry and never returns it", async () => {
    const { admin } = await setup();
    const priv = new TestRegistry();
    await priv.start();
    try {
      const keys = generatePublisherKeys();
      const created = await json<DesktopAppRegistryView>(
        await admin.post("/api/desktop-apps/registries", {
          kind: "private",
          name: "Company",
          url: `${priv.base}/index.json`,
          publicKey: keys.publicKey,
          fingerprint: keyFingerprint(keys.publicKey),
          token: "company-registry-token",
          allowPrivate: true,
        }),
      );
      expect(created.hasToken).toBe(true);
      expect(JSON.stringify(created)).not.toContain("company-registry-token");
      await admin.post(`/api/desktop-apps/registries/${created.id}/sync`, {});
      expect(priv.requests[0]).toEqual({
        path: "/index.json",
        authorization: "Bearer company-registry-token",
      });
    } finally {
      await priv.stop();
    }
  });
});

describe("desktop app installation", () => {
  it("installs only after approval, serves the files sandboxed and uninstalls everything", async () => {
    const { ctx, admin, viewer, registry } = await setup();
    const notes = await buildApp(
      "dev.everyos.notes",
      "1.0.0",
      ["storage:app", "system:metrics.read"],
      officialKeys.privateKey,
    );
    publish(registry, index([{ id: "dev.everyos.notes", versions: [notes] }]), [notes]);
    await sync(admin);
    expect(
      (
        await viewer.post("/api/desktop-apps/installed", {
          registryId: "official",
          appId: "dev.everyos.notes",
        })
      ).status,
    ).toBe(403);
    const unapproved = await admin.post("/api/desktop-apps/installed", {
      registryId: "official",
      appId: "dev.everyos.notes",
    });
    expect(unapproved.status).toBe(409);
    expect(await code(unapproved)).toMatchObject({
      code: "DESKTOP_APP_APPROVAL_REQUIRED",
      details: { sensitive: ["system:metrics.read"], elevated: [] },
    });
    const installed = await json<DesktopAppInstallationView>(
      await admin.post("/api/desktop-apps/installed", {
        registryId: "official",
        appId: "dev.everyos.notes",
        approve: ["system:metrics.read"],
      }),
    );
    expect(installed).toMatchObject({
      appId: "dev.everyos.notes",
      version: "1.0.0",
      state: "active",
    });
    expect(installed.runtimeUrl).toMatch(/^\/app-runtime\/[a-f0-9]{32}\/$/);

    const page = await viewer.get(`${installed.runtimeUrl}index.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>1.0.0</title>");
    expect(page.headers.get("content-security-policy")).toBe(RUNTIME_CSP);
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(page.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(page.headers.get("access-control-allow-origin")).toBe("*");
    for (const path of ["missing.html", "..%2Fpackages", "%2e%2e/x.js", "manifest.json/x"])
      expect((await viewer.get(`${installed.runtimeUrl}${path}`)).status, path).toBe(404);
    // Everything else keeps refusing to be framed.
    expect((await viewer.get("/api/desktop-apps/installed")).headers.get("x-frame-options")).toBe(
      "DENY",
    );

    expect(
      (
        await admin.request("DELETE", "/api/desktop-apps/installed/dev.everyos.notes", {
          body: { confirm: true },
        })
      ).status,
    ).toBe(204);
    expect((await viewer.get(`${installed.runtimeUrl}index.html`)).status).toBe(404);
    expect(await readdir(join(ctx.config.desktopApps.dir, "apps"))).toEqual([]);
    expect(await readdir(join(ctx.config.desktopApps.dir, "packages"))).toEqual([]);
    const audit = ctx.db
      .all<{ action: string }>(
        "SELECT action FROM audit_events WHERE action LIKE 'desktop-apps.%' ORDER BY rowid",
      )
      .map((row) => row.action);
    expect(audit).toEqual([
      "desktop-apps.registry.sync",
      "desktop-apps.install",
      "desktop-apps.install",
      "desktop-apps.uninstall",
    ]);
  });

  it("refuses tampered packages and manifests that differ from the registry, leaving nothing", async () => {
    const { ctx, admin, registry } = await setup();
    const notes = await buildApp(
      "dev.everyos.notes",
      "1.0.0",
      ["storage:app"],
      officialKeys.privateKey,
    );
    publish(registry, index([{ id: "dev.everyos.notes", versions: [notes] }]), [notes]);
    await sync(admin);
    registry.files.set(
      `/${notes.version.package.url}`,
      Buffer.concat([notes.bytes, Buffer.from("x")]),
    );
    const tampered = await admin.post("/api/desktop-apps/installed", {
      registryId: "official",
      appId: "dev.everyos.notes",
    });
    expect(tampered.status).toBe(502);
    expect(await code(tampered)).toMatchObject({ code: "DESKTOP_APP_PACKAGE_INVALID" });

    // The registry lists fewer permissions than the package really asks for.
    const sneaky = await buildApp(
      "dev.everyos.notes",
      "1.0.0",
      ["storage:app", "logs:read"],
      officialKeys.privateKey,
    );
    const listed = { ...sneaky, version: { ...sneaky.version, manifest: notes.version.manifest } };
    publish(registry, index([{ id: "dev.everyos.notes", versions: [listed] }], { sequence: 2 }), [
      listed,
    ]);
    await sync(admin);
    const mismatch = await admin.post("/api/desktop-apps/installed", {
      registryId: "official",
      appId: "dev.everyos.notes",
    });
    expect(await code(mismatch)).toMatchObject({
      code: "DESKTOP_APP_PACKAGE_INVALID",
      details: { reason: "manifest-mismatch" },
    });
    expect(
      (await json<{ apps: unknown[] }>(await admin.get("/api/desktop-apps/installed"))).apps,
    ).toEqual([]);
    expect(existsSync(join(ctx.config.desktopApps.dir, "apps", "dev.everyos.notes", "1.0.0"))).toBe(
      false,
    );
    expect(await readdir(join(ctx.config.desktopApps.dir, "staging"))).toEqual([]);
  });

  it("keeps elevated capabilities for administrators", async () => {
    const { admin, operator, registry } = await setup();
    const tool = await buildApp(
      "dev.everyos.apiclient",
      "1.0.0",
      ["storage:app", "network:outbound"],
      officialKeys.privateKey,
    );
    publish(registry, index([{ id: "dev.everyos.apiclient", versions: [tool] }]), [tool]);
    await sync(admin);
    const request = {
      registryId: "official",
      appId: "dev.everyos.apiclient",
      approve: ["network:outbound"],
    };
    expect((await operator.post("/api/desktop-apps/installed", request)).status).toBe(403);
    expect((await admin.post("/api/desktop-apps/installed", request)).status).toBe(201);
  });

  it("updates with approval for new capabilities, retires the old files and honours revocations", async () => {
    const { ctx, admin, viewer, registry } = await setup();
    const v1 = await buildApp(
      "dev.everyos.notes",
      "1.0.0",
      ["storage:app"],
      officialKeys.privateKey,
    );
    publish(registry, index([{ id: "dev.everyos.notes", versions: [v1] }]), [v1]);
    await sync(admin);
    const first = await json<DesktopAppInstallationView>(
      await admin.post("/api/desktop-apps/installed", {
        registryId: "official",
        appId: "dev.everyos.notes",
      }),
    );
    const v2 = await buildApp(
      "dev.everyos.notes",
      "1.1.0",
      ["storage:app", "logs:read"],
      officialKeys.privateKey,
    );
    publish(registry, index([{ id: "dev.everyos.notes", versions: [v1, v2] }], { sequence: 2 }), [
      v1,
      v2,
    ]);
    await sync(admin);
    const listing = (
      await json<{ apps: DesktopAppListing[] }>(await admin.get("/api/desktop-apps/catalog"))
    ).apps[0]!;
    expect(listing.updateAvailable).toBe("1.1.0");
    const unapproved = await admin.post("/api/desktop-apps/installed/dev.everyos.notes/update", {});
    expect(await code(unapproved)).toMatchObject({
      code: "DESKTOP_APP_APPROVAL_REQUIRED",
      details: { sensitive: ["logs:read"] },
    });
    const updated = await json<DesktopAppInstallationView>(
      await admin.post("/api/desktop-apps/installed/dev.everyos.notes/update", {
        approve: ["logs:read"],
      }),
    );
    expect(updated.version).toBe("1.1.0");
    expect(updated.runtimeUrl).not.toBe(first.runtimeUrl);
    expect((await viewer.get(`${first.runtimeUrl}index.html`)).status).toBe(404);
    expect(await (await viewer.get(`${updated.runtimeUrl}index.html`)).text()).toContain("1.1.0");
    expect(await readdir(join(ctx.config.desktopApps.dir, "apps", "dev.everyos.notes"))).toEqual([
      "1.1.0",
    ]);

    publish(
      registry,
      index([{ id: "dev.everyos.notes", versions: [v1, v2] }], {
        sequence: 3,
        revoked: [{ appId: "dev.everyos.notes", version: "1.1.0", reason: "Data loss bug" }],
      }),
      [v1, v2],
    );
    await sync(admin);
    const revoked = (
      await json<{ apps: DesktopAppInstallationView[] }>(
        await viewer.get("/api/desktop-apps/installed"),
      )
    ).apps[0]!;
    expect(revoked).toMatchObject({ state: "revoked", stateReason: "Data loss bug" });
    expect((await viewer.get(`${updated.runtimeUrl}index.html`)).status).toBe(404);
    const enable = await admin.request("PATCH", "/api/desktop-apps/installed/dev.everyos.notes", {
      body: { enabled: true },
    });
    expect(await code(enable)).toMatchObject({ code: "DESKTOP_APP_REVOKED" });
  });

  it("refuses apps this EveryOS cannot run", async () => {
    const { admin, registry } = await setup();
    const future = await buildApp(
      "dev.everyos.notes",
      "1.0.0",
      ["storage:app"],
      officialKeys.privateKey,
      { sdk: "^2.0.0" },
    );
    publish(registry, index([{ id: "dev.everyos.notes", versions: [future] }]), [future]);
    await sync(admin);
    const listing = (
      await json<{ apps: DesktopAppListing[] }>(await admin.get("/api/desktop-apps/catalog"))
    ).apps[0]!;
    expect(listing.incompatible).toBe("sdk-unsupported");
    const install = await admin.post("/api/desktop-apps/installed", {
      registryId: "official",
      appId: "dev.everyos.notes",
    });
    expect(await code(install)).toMatchObject({ code: "DESKTOP_APP_INCOMPATIBLE" });
  });
});

describe("app SDK calls", () => {
  async function installed(
    admin: TestClient,
    target: TestRegistry,
    apps: Array<{ id: string; permissions: string[]; overrides?: Record<string, unknown> }>,
  ) {
    const builds = await Promise.all(
      apps.map((app) =>
        buildApp(app.id, "1.0.0", app.permissions, officialKeys.privateKey, app.overrides),
      ),
    );
    publish(target, index(apps.map((app, i) => ({ id: app.id, versions: [builds[i]!] }))), builds);
    await sync(admin);
    for (const app of apps)
      expect(
        (
          await admin.post("/api/desktop-apps/installed", {
            registryId: "official",
            appId: app.id,
            approve: app.permissions.filter((p) => p !== "storage:app" && p !== "widgets:register"),
          })
        ).status,
      ).toBe(201);
  }
  const open = async (client: TestClient, appId: string, kind = "window", widgetId?: string) => {
    const response = await client.post("/api/app-sdk/instances", {
      appId,
      kind,
      ...(widgetId ? { widgetId } : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as { token: string; granted: string[] },
    };
  };
  const as = (token: string) => ({ headers: { "x-everyos-app-instance": token } });

  it("keeps each app's data to itself and to each person", async () => {
    const { admin, operator, registry } = await setup();
    await installed(admin, registry, [
      { id: "dev.everyos.notes", permissions: ["storage:app"] },
      { id: "dev.everyos.todo", permissions: ["storage:app"] },
      { id: "dev.everyos.calculator", permissions: [] },
    ]);
    const notes = (await open(admin, "dev.everyos.notes")).body.token;
    const todo = (await open(admin, "dev.everyos.todo")).body.token;
    const operatorNotes = (await open(operator, "dev.everyos.notes")).body.token;
    const set = (client: TestClient, token: string, key: string, value: unknown) =>
      client.request("POST", "/api/app-sdk/storage/set", { body: { key, value }, ...as(token) });
    const get = async (client: TestClient, token: string, key: string) =>
      (
        await json<{ entry: { value: unknown } | null }>(
          await client.request("POST", "/api/app-sdk/storage/get", { body: { key }, ...as(token) }),
        )
      ).entry;
    expect((await set(admin, notes, "draft", { text: "admin's note" })).status).toBe(204);
    expect(await get(admin, notes, "draft")).toEqual({ value: { text: "admin's note" } });
    expect(await get(admin, todo, "draft")).toBeNull();
    expect(await get(operator, operatorNotes, "draft")).toBeNull();
    // A token belongs to its session: another person's session cannot use it.
    expect(
      (
        await operator.request("POST", "/api/app-sdk/storage/get", {
          body: { key: "draft" },
          ...as(notes),
        })
      ).status,
    ).toBe(404);
    const keys = await json<{ keys: Array<{ key: string }> }>(
      await admin.request("POST", "/api/app-sdk/storage/keys", {
        body: { prefix: "dr" },
        ...as(notes),
      }),
    );
    expect(keys.keys.map((k) => k.key)).toEqual(["draft"]);
    // An app without the capability gets nothing.
    const calculator = (await open(admin, "dev.everyos.calculator")).body.token;
    const refused = await admin.request("POST", "/api/app-sdk/storage/get", {
      body: { key: "draft" },
      ...as(calculator),
    });
    expect(refused.status).toBe(403);
    expect((await json<ApiErrorBody>(refused)).error.details).toEqual({
      capability: "storage:app",
    });
  });

  it("limits a person to what their role allows and a widget to its declared capabilities", async () => {
    const { admin, viewer, registry } = await setup();
    await installed(admin, registry, [
      {
        id: "dev.everyos.logs",
        permissions: ["storage:app", "logs:read", "widgets:register"],
        overrides: {
          widgets: [
            {
              id: "tail",
              name: "Tail",
              description: "Latest lines",
              entry: "widget.html",
              sizes: ["small"],
              defaultSize: "small",
              placements: ["desktop"],
              permissions: ["logs:read"],
            },
          ],
        },
      },
    ]);
    expect((await open(admin, "dev.everyos.logs")).body.granted.sort()).toEqual([
      "logs:read",
      "storage:app",
      "widgets:register",
    ]);
    // Viewers cannot read logs, so the app cannot read them for a viewer either.
    expect((await open(viewer, "dev.everyos.logs")).body.granted.sort()).toEqual([
      "storage:app",
      "widgets:register",
    ]);
    const widget = await open(admin, "dev.everyos.logs", "widget", "tail");
    expect(widget.status).toBe(201);
    expect(
      (
        await admin.request("POST", "/api/app-sdk/storage/get", {
          body: { key: "x" },
          ...as(widget.body.token),
        })
      ).status,
    ).toBe(403);
    expect((await open(admin, "dev.everyos.logs", "widget", "missing")).status).toBe(404);
  });

  it("ends instances when the app goes, and bounds storage", async () => {
    const { admin, registry } = await setup();
    await installed(admin, registry, [{ id: "dev.everyos.notes", permissions: ["storage:app"] }]);
    const token = (await open(admin, "dev.everyos.notes")).body.token;
    const big = "x".repeat(200 * 1024);
    let full: number | null = null;
    for (let i = 0; i < 100 && full === null; i++) {
      const response = await admin.request("POST", "/api/app-sdk/storage/set", {
        body: { key: `k${i}`, value: big },
        ...as(token),
      });
      if (response.status !== 204) {
        expect((await json<ApiErrorBody>(response)).error.code).toBe("DESKTOP_APP_STORAGE_FULL");
        full = i;
      }
    }
    // 16 MiB holds 81 values of ~200 KiB; the 82nd does not fit.
    expect(full).toBe(81);
    const usage = await json<{ used: number; quota: number; keys: number }>(
      await admin.request("GET", "/api/app-sdk/storage/usage", as(token)),
    );
    expect(usage.keys).toBe(81);
    expect(usage.used).toBeLessThanOrEqual(usage.quota);
    const tooBig = await admin.request("POST", "/api/app-sdk/storage/set", {
      body: { key: "huge", value: "x".repeat(300 * 1024) },
      ...as(token),
    });
    expect(tooBig.status).toBe(413);
    expect(
      (
        await admin.request("DELETE", "/api/desktop-apps/installed/dev.everyos.notes", {
          body: { confirm: true },
        })
      ).status,
    ).toBe(204);
    expect((await admin.request("GET", "/api/app-sdk/storage/usage", as(token))).status).toBe(404);
  });
});

describe("app file access", () => {
  async function withApp(permissions: string[]) {
    const context = await setup();
    const build = await buildApp(
      "dev.everyos.files",
      "1.0.0",
      permissions,
      officialKeys.privateKey,
    );
    publish(context.registry, index([{ id: "dev.everyos.files", versions: [build] }]), [build]);
    await sync(context.admin);
    expect(
      (
        await context.admin.post("/api/desktop-apps/installed", {
          registryId: "official",
          appId: "dev.everyos.files",
        })
      ).status,
    ).toBe(201);
    const open = async () =>
      (
        await json<{ token: string }>(
          await context.admin.post("/api/app-sdk/instances", {
            appId: "dev.everyos.files",
            kind: "window",
          }),
        )
      ).token;
    const root = context.ctx.config.files.roots[0]!.path;
    return { ...context, open, root };
  }
  const as = (token: string) => ({ headers: { "x-everyos-app-instance": token } });

  it("reads only what the person picked, in chunks, and never past a link", async () => {
    const { admin, open, root } = await withApp(["files:pick"]);
    const token = await open();
    mkdirSync(join(root, "music"), { recursive: true });
    writeFileSync(join(root, "music", "song.txt"), "x".repeat(700 * 1024));
    writeFileSync(join(root, "secret.txt"), "not shared");
    symlinkSync(join(root, "secret.txt"), join(root, "music", "escape.txt"));
    symlinkSync(root, join(root, "music", "up"));
    const grant = await json<{ handles: Array<{ id: string; kind: string }> }>(
      await admin.request("POST", "/api/app-sdk/files/grants", {
        body: { items: [{ root: "dev", path: "music" }], write: false, persist: false },
        ...as(token),
      }),
    );
    const folder = grant.handles[0]!;
    expect(folder.kind).toBe("directory");
    const list = await json<{ entries: Array<{ name: string }> }>(
      await admin.request("GET", `/api/app-sdk/files/${folder.id}/list?path=`, as(token)),
    );
    // Links are not listed, and cannot be opened by name either.
    expect(list.entries.map((entry) => entry.name)).toEqual(["song.txt"]);
    for (const path of ["escape.txt", "up/secret.txt"])
      expect(
        (
          await admin.request("POST", `/api/app-sdk/files/${folder.id}/child`, {
            body: { path, create: null },
            ...as(token),
          })
        ).status,
        path,
      ).toBe(404);
    const song = await json<{ handle: { id: string; size: number } }>(
      await admin.request("POST", `/api/app-sdk/files/${folder.id}/child`, {
        body: { path: "song.txt", create: null },
        ...as(token),
      }),
    );
    expect(song.handle.size).toBe(700 * 1024);
    const first = await admin.request(
      "GET",
      `/api/app-sdk/files/${song.handle.id}/read?offset=0&length=524288`,
      as(token),
    );
    expect(first.headers.get("x-everyos-eof")).toBe("0");
    expect((await first.arrayBuffer()).byteLength).toBe(524288);
    const second = await admin.request(
      "GET",
      `/api/app-sdk/files/${song.handle.id}/read?offset=524288&length=524288`,
      as(token),
    );
    expect(second.headers.get("x-everyos-eof")).toBe("1");
    expect((await second.arrayBuffer()).byteLength).toBe(700 * 1024 - 524288);
    // Reading is not writing.
    const write = await admin.request(
      "POST",
      `/api/app-sdk/files/${song.handle.id}/write?offset=0&done=true`,
      {
        rawBody: "changed",
        ...as(token),
      },
    );
    expect(write.status).toBe(403);
    expect(
      (
        await admin.request("POST", "/api/app-sdk/files/grants", {
          body: { items: [{ root: "dev", path: "../etc" }], write: false, persist: false },
          ...as(token),
        })
      ).status,
    ).toBe(400);
  });

  it("saves in ordered chunks that land atomically", async () => {
    const { admin, open, root } = await withApp(["files:pick", "files:save"]);
    const token = await open();
    mkdirSync(join(root, "docs"), { recursive: true });
    const saved = await json<{ handle: { id: string; writable: boolean } }>(
      await admin.request("POST", "/api/app-sdk/files/grants/save", {
        body: { root: "dev", path: "docs", name: "note.md", persist: false },
        ...as(token),
      }),
    );
    expect(saved.handle.writable).toBe(true);
    const write = (offset: number, body: string, done: boolean) =>
      admin.request(
        "POST",
        `/api/app-sdk/files/${saved.handle.id}/write?offset=${offset}&done=${done}`,
        {
          rawBody: body,
          ...as(token),
        },
      );
    expect((await write(0, "# Title\n", false)).status).toBe(200);
    // Nothing changes on disk until the last chunk.
    expect(readFileSync(join(root, "docs", "note.md"), "utf8")).toBe("");
    expect((await write(3, "late", false)).status).toBe(409);
    expect((await write(0, "# Title\n", false)).status).toBe(200);
    expect(await json<{ size: number }>(await write(8, "Body\n", true))).toEqual({ size: 13 });
    expect(readFileSync(join(root, "docs", "note.md"), "utf8")).toBe("# Title\nBody\n");
  });

  it("ends temporary grants with their window and keeps persistent ones", async () => {
    const { admin, open, root } = await withApp(["files:pick"]);
    writeFileSync(join(root, "a.txt"), "a");
    const first = await open();
    const grant = (persist: boolean) =>
      admin.request("POST", "/api/app-sdk/files/grants", {
        body: { items: [{ root: "dev", path: "a.txt" }], write: false, persist },
        ...as(first),
      });
    const temporary = (await json<{ handles: Array<{ id: string }> }>(await grant(false)))
      .handles[0]!.id;
    const kept = (await json<{ handles: Array<{ id: string }> }>(await grant(true))).handles[0]!.id;
    const second = await open();
    // Another window of the app does not get the first one's temporary grant.
    expect((await admin.request("GET", `/api/app-sdk/files/${temporary}`, as(second))).status).toBe(
      404,
    );
    expect((await admin.request("GET", `/api/app-sdk/files/${kept}`, as(second))).status).toBe(200);
    await admin.request("DELETE", "/api/app-sdk/instances/current", { body: {}, ...as(first) });
    const remaining = await json<{ handles: Array<{ id: string }> }>(
      await admin.request("GET", "/api/app-sdk/files", as(second)),
    );
    expect(remaining.handles.map((h) => h.id)).toEqual([kept]);
  });

  it("serves media URLs with ranges, without cookies, until the grant goes", async () => {
    const { ctx, admin, open, root } = await withApp(["files:pick"]);
    const token = await open();
    writeFileSync(join(root, "clip.mp4"), "0123456789");
    const handle = (
      await json<{ handles: Array<{ id: string }> }>(
        await admin.request("POST", "/api/app-sdk/files/grants", {
          body: { items: [{ root: "dev", path: "clip.mp4" }], write: false, persist: false },
          ...as(token),
        }),
      )
    ).handles[0]!.id;
    const { url } = await json<{ url: string }>(
      await admin.request("POST", `/api/app-sdk/files/${handle}/url`, { body: {}, ...as(token) }),
    );
    const anonymous = new TestClient(ctx);
    const ranged = await anonymous.request("GET", url, { headers: { range: "bytes=2-5" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("2345");
    expect(ranged.headers.get("content-type")).toBe("video/mp4");
    expect(ranged.headers.get("access-control-allow-origin")).toBe("*");
    await admin.request("DELETE", `/api/app-sdk/files/${handle}`, { body: {}, ...as(token) });
    expect((await anonymous.request("GET", url)).status).toBe(404);
  });
});

describe("app notifications and host data", () => {
  async function withApp(permissions: string[], approve: string[] = []) {
    const context = await setup();
    const build = await buildApp(
      "dev.everyos.monitor",
      "1.0.0",
      permissions,
      officialKeys.privateKey,
    );
    publish(context.registry, index([{ id: "dev.everyos.monitor", versions: [build] }]), [build]);
    await sync(context.admin);
    expect(
      (
        await context.admin.post("/api/desktop-apps/installed", {
          registryId: "official",
          appId: "dev.everyos.monitor",
          approve,
        })
      ).status,
    ).toBe(201);
    const open = async (client: TestClient) =>
      (
        await json<{ token: string }>(
          await client.post("/api/app-sdk/instances", {
            appId: "dev.everyos.monitor",
            kind: "window",
          }),
        )
      ).token;
    return { ...context, open };
  }
  const as = (token: string) => ({ headers: { "x-everyos-app-instance": token } });
  const appMessages = async (client: TestClient) =>
    (
      await json<{
        notifications: Array<{ kind: string; severity: string; params: Record<string, unknown> }>;
      }>(await client.get("/api/notifications"))
    ).notifications.filter((n) => n.kind === "app-message");

  it("notifies only the person using the app, bounded and switchable off", async () => {
    const { admin, operator, open } = await withApp(["notifications:send"]);
    const token = await open(admin);
    const notify = (level: string, tag: string | null = null) =>
      admin.request("POST", "/api/app-sdk/notifications", {
        body: { title: "Timer done", body: "Take a break", level, tag },
        ...as(token),
      });
    expect((await notify("critical", "focus")).status).toBe(204);
    const [message] = await appMessages(admin);
    expect(message).toMatchObject({
      severity: "warning",
      params: { app: "Notes", title: "Timer done", body: "Take a break" },
    });
    expect(await appMessages(operator)).toEqual([]);
    for (let i = 0; i < 9; i++) expect((await notify("info")).status).toBe(204);
    expect((await notify("info")).status).toBe(429);
    expect(
      (
        await admin.request("PUT", "/api/desktop-apps/installed/dev.everyos.monitor/settings", {
          body: { notifications: false },
        })
      ).status,
    ).toBe(200);
    const before = (await appMessages(admin)).length;
    expect((await notify("info", "silenced")).status).toBe(204);
    expect((await appMessages(admin)).length).toBe(before);
  });

  it("serves host data only behind granted capabilities the person's role allows", async () => {
    const {
      ctx,
      admin,
      viewer,
      open,
      registry: _registry,
    } = await withApp(["system:metrics.read", "logs:read"], ["system:metrics.read", "logs:read"]);
    const token = await open(admin);
    const host = (client: TestClient, instance: string, operation: string, input: unknown = null) =>
      client.request("POST", `/api/app-sdk/host/${operation}`, {
        body: { input },
        ...as(instance),
      });
    const metrics = await host(admin, token, "system.metrics");
    expect(metrics.status).toBe(200);
    expect(await json(metrics)).toHaveProperty("result.point.at");
    expect((await host(admin, token, "logs.query", { limit: 5 })).status).toBe(200);
    expect((await host(admin, token, "logs.query", { limit: 5000 })).status).toBe(400);
    // Granted to the app, but sockets were never asked for.
    expect((await host(admin, token, "system.sockets")).status).toBe(403);
    expect((await host(admin, token, "shell.exec")).status).toBe(404);
    // A viewer may not read logs, so the app may not for them either.
    const viewerToken = await open(viewer);
    expect((await host(viewer, viewerToken, "logs.query", { limit: 5 })).status).toBe(403);
    expect((await host(viewer, viewerToken, "system.metrics")).status).toBe(200);
    expect(ctx).toBeDefined();
  });

  it("sizes a shared folder without following links", async () => {
    const { ctx, admin, open } = await withApp(
      ["files:pick", "storage:usage.read"],
      ["storage:usage.read"],
    );
    const token = await open(admin);
    const root = ctx.config.files.roots[0]!.path;
    mkdirSync(join(root, "media", "films"), { recursive: true });
    writeFileSync(join(root, "media", "films", "big.mkv"), Buffer.alloc(5000));
    writeFileSync(join(root, "media", "song.mp3"), Buffer.alloc(300));
    writeFileSync(join(root, "outside.bin"), Buffer.alloc(9999));
    symlinkSync(root, join(root, "media", "loop"));
    const handle = (
      await json<{ handles: Array<{ id: string }> }>(
        await admin.request("POST", "/api/app-sdk/files/grants", {
          body: { items: [{ root: "dev", path: "media" }], write: false, persist: false },
          ...as(token),
        }),
      )
    ).handles[0]!.id;
    const usage = await json<{
      result: {
        total: number;
        children: Array<{ name: string; size: number }>;
        largest: Array<{ path: string }>;
        types: Array<{ extension: string }>;
      };
    }>(
      await admin.request("POST", "/api/app-sdk/host/disk.usage", {
        body: { input: { handle } },
        ...as(token),
      }),
    );
    expect(usage.result.total).toBe(5300);
    expect(usage.result.children.map((child) => [child.name, child.size])).toEqual([
      ["films", 5000],
      ["song.mp3", 300],
    ]);
    expect(usage.result.largest[0]!.path).toBe("films/big.mkv");
    expect(usage.result.types.map((type) => type.extension)).toEqual(["mkv", "mp3"]);
  });
});

/** A local upstream for network tests: records what reached it. */
class Upstream {
  readonly seen: Array<{
    url: string;
    method: string;
    headers: IncomingHttpHeaders;
    body: string;
  }> = [];
  failing = false;
  closedPort = 0;
  readonly server: Server;
  port = 0;
  constructor(tls?: { key: Buffer; cert: Buffer }) {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.seen.push({
          url: req.url ?? "",
          method: req.method ?? "",
          headers: req.headers,
          body,
        });
        switch (req.url ?? "") {
          case "/hello":
            res.writeHead(this.failing ? 500 : 200, {
              "Content-Type": "application/json",
              "X-Test": "yes",
            });
            res.end(JSON.stringify({ hello: "world" }));
            return;
          case "/echo":
            res.writeHead(201, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ method: req.method, body, headers: req.headers }));
            return;
          case "/redirect":
            res.writeHead(302, { Location: "/hello" });
            res.end();
            return;
          case "/away":
            res.writeHead(302, { Location: `http://127.0.0.1:${this.closedPort}/hello` });
            res.end();
            return;
          case "/gzip":
            res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
            res.end(gzipSync("compressed text ".repeat(100)));
            return;
          case "/big":
            res.writeHead(200, { "Content-Type": "application/octet-stream" });
            res.end(Buffer.alloc(3 * 1024 * 1024, 7));
            return;
          case "/slow":
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.write("started");
            return;
          default:
            res.writeHead(404);
            res.end();
        }
      });
    };
    this.server = tls ? createHttpsServer(tls, handler) : createServer(handler);
  }
  async start() {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.port = (this.server.address() as AddressInfo).port;
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    this.closedPort = (probe.address() as AddressInfo).port;
    probe.close();
    await once(probe, "close");
  }
  async stop() {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, "close");
  }
}

/** A DNS server over UDP answering A queries for the given names (NXDOMAIN otherwise). */
async function dnsServer(records: Record<string, string>) {
  const socket = createSocket("udp4");
  const u16 = (value: number) => Buffer.from([value >> 8, value & 255]);
  socket.on("message", (message, peer) => {
    let offset = 12;
    const labels: string[] = [];
    while (message[offset]) {
      const length = message[offset]!;
      labels.push(message.subarray(offset + 1, offset + 1 + length).toString());
      offset += length + 1;
    }
    offset += 1;
    const type = message.readUInt16BE(offset);
    const question = message.subarray(12, offset + 4);
    const address = records[labels.join(".").toLowerCase()];
    const answer =
      address && type === 1
        ? Buffer.concat([
            Buffer.from([0xc0, 0x0c]),
            u16(1),
            u16(1),
            Buffer.from([0, 0, 1, 44]),
            u16(4),
            Buffer.from(address.split(".").map(Number)),
          ])
        : null;
    const header = Buffer.concat([
      message.subarray(0, 2),
      u16(address ? 0x8180 : 0x8183),
      u16(1),
      u16(answer ? 1 : 0),
      u16(0),
      u16(0),
    ]);
    socket.send(
      Buffer.concat([header, question, answer ?? Buffer.alloc(0)]),
      peer.port,
      peer.address,
    );
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return { port: socket.address().port, close: () => socket.close() };
}

describe("app network access", () => {
  const upstreams: Upstream[] = [];
  afterEach(async () => {
    for (const upstream of upstreams.splice(0)) await upstream.stop();
  });
  const names: Record<string, Array<{ address: string; family: number }>> = {
    "api.example.com": [{ address: "93.184.216.34", family: 4 }],
    "deep.api.example.com": [{ address: "93.184.216.35", family: 4 }],
    "example.com": [{ address: "93.184.216.36", family: 4 }],
    "intranet.example.com": [{ address: "10.1.2.3", family: 4 }],
    "mixed.example.com": [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  };
  const resolve = (hostname: string) => {
    const found = names[hostname];
    return found
      ? Promise.resolve(found)
      : Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
  };
  const as = (token: string) => ({ headers: { "x-everyos-app-instance": token } });

  async function withNetworkApp(
    permissions = ["network:outbound", "notifications:send"],
    approve = ["network:outbound"],
  ) {
    const context = await setup({ resolve });
    const build = await buildApp(
      "dev.everyos.netprobe",
      "1.0.0",
      permissions,
      officialKeys.privateKey,
    );
    const other = await buildApp(
      "dev.everyos.other",
      "1.0.0",
      ["storage:app"],
      officialKeys.privateKey,
    );
    publish(
      context.registry,
      index([
        { id: "dev.everyos.netprobe", versions: [build] },
        { id: "dev.everyos.other", versions: [other] },
      ]),
      [build, other],
    );
    await sync(context.admin);
    for (const [appId, approved] of [
      ["dev.everyos.netprobe", approve],
      ["dev.everyos.other", []],
    ] as const)
      expect(
        (
          await context.admin.post("/api/desktop-apps/installed", {
            registryId: "official",
            appId,
            approve: approved,
          })
        ).status,
      ).toBe(201);
    const open = async (client: TestClient, appId = "dev.everyos.netprobe") =>
      (
        await json<{ token: string }>(
          await client.post("/api/app-sdk/instances", { appId, kind: "window" }),
        )
      ).token;
    const host = (client: TestClient, token: string, operation: string, input: unknown = null) =>
      client.request("POST", `/api/app-sdk/host/${operation}`, { body: { input }, ...as(token) });
    const rule = (body: Record<string, unknown>, client = context.admin) =>
      client.post("/api/desktop-apps/network-rules", body);
    return { ...context, open, host, rule };
  }

  it("lets administrators scope what apps may reach, and refuses everything else", async () => {
    const { ctx, admin, operator, viewer, rule } = await withNetworkApp();
    const network = ctx.services.desktopApps.network;
    const refusal = async (host: string, port: number, appId = "dev.everyos.netprobe") =>
      network.target(appId, host, port).then(
        () => null,
        (error: { code: string; details: { reason: string } }) => [
          error.code,
          error.details.reason,
        ],
      );
    // Nothing is reachable until an administrator allows it.
    expect(await refusal("api.example.com", 443)).toEqual([
      "DESKTOP_APP_NETWORK_BLOCKED",
      "policy",
    ]);
    expect(
      (await rule({ kind: "host", pattern: "*.example.com", ports: [443] }, operator)).status,
    ).toBe(403);
    expect((await rule({ kind: "host", pattern: "*.Example.com", ports: [443] })).status).toBe(201);
    expect((await rule({ kind: "host", pattern: "*.example.com", ports: [443] })).status).toBe(409);
    expect((await operator.get("/api/desktop-apps/network-rules")).status).toBe(200);
    expect((await viewer.get("/api/desktop-apps/network-rules")).status).toBe(403);

    expect(await network.target("dev.everyos.netprobe", "api.example.com", 443)).toEqual({
      host: "api.example.com",
      address: "93.184.216.34",
      family: 4,
    });
    expect(await refusal("deep.api.example.com", 443)).toBeNull();
    // The wildcard covers subdomains only, on the listed ports only.
    expect(await refusal("example.com", 443)).toEqual(["DESKTOP_APP_NETWORK_BLOCKED", "policy"]);
    expect(await refusal("evilexample.com", 443)).toEqual([
      "DESKTOP_APP_NETWORK_BLOCKED",
      "policy",
    ]);
    expect(await refusal("api.example.com", 80)).toEqual(["DESKTOP_APP_NETWORK_BLOCKED", "policy"]);
    // A host rule never reaches private addresses, even partly (DNS rebinding).
    expect(await refusal("intranet.example.com", 443)).toEqual([
      "DESKTOP_APP_NETWORK_BLOCKED",
      "address",
    ]);
    expect(await refusal("mixed.example.com", 443)).toEqual([
      "DESKTOP_APP_NETWORK_BLOCKED",
      "address",
    ]);
    expect(await refusal("93.184.216.34", 443)).toEqual(["DESKTOP_APP_NETWORK_BLOCKED", "policy"]);

    // Private ranges need a CIDR rule, which may belong to one app only.
    expect(
      (
        await rule({
          kind: "cidr",
          pattern: "10.1.2.0/24",
          ports: [443],
          appId: "dev.everyos.other",
        })
      ).status,
    ).toBe(201);
    expect(await refusal("intranet.example.com", 443)).toEqual([
      "DESKTOP_APP_NETWORK_BLOCKED",
      "address",
    ]);
    expect(await refusal("10.1.2.3", 443, "dev.everyos.other")).toBeNull();
    expect(
      (
        await rule({
          kind: "cidr",
          pattern: "10.1.2.0/24",
          ports: [443],
          appId: "dev.everyos.netprobe",
        })
      ).status,
    ).toBe(201);
    expect(await refusal("intranet.example.com", 443)).toBeNull();

    // Never: cloud metadata and link-local, whatever the rules say; no "everything" ranges.
    expect((await rule({ kind: "cidr", pattern: "169.254.0.0/16", ports: [80] })).status).toBe(201);
    expect(await refusal("169.254.169.254", 80)).toEqual([
      "DESKTOP_APP_NETWORK_BLOCKED",
      "address",
    ]);
    for (const pattern of ["0.0.0.0/0", "10.0.0.0/4", "::/0", "300.1.1.1/24"])
      expect((await rule({ kind: "cidr", pattern, ports: [80] })).status, pattern).toBe(400);
    expect((await rule({ kind: "host", pattern: "*", ports: [80] })).status).toBe(400);
    expect((await rule({ kind: "host", pattern: "10.0.0.1", ports: [80] })).status).toBe(400);

    const loopback = await json<DesktopAppNetworkRuleView>(
      await rule({ kind: "cidr", pattern: "127.0.0.1/32", ports: [8080], note: "Local service" }),
    );
    expect(loopback).toMatchObject({ includesThisServer: true, createdBy: "admin" });
    const scoped = await json<{ rules: DesktopAppNetworkRuleView[] }>(
      await admin.get("/api/desktop-apps/network-rules?appId=dev.everyos.other"),
    );
    expect(scoped.rules.map((entry) => entry.appId)).not.toContain("dev.everyos.netprobe");
    expect(
      (await admin.delete(`/api/desktop-apps/network-rules/${loopback.id}`, { body: {} })).status,
    ).toBe(204);
    // Uninstalling an app takes its own rules with it.
    expect(
      (
        await admin.delete("/api/desktop-apps/installed/dev.everyos.other", {
          body: { confirm: true },
        })
      ).status,
    ).toBe(204);
    const left = await json<{ rules: DesktopAppNetworkRuleView[] }>(
      await admin.get("/api/desktop-apps/network-rules"),
    );
    expect(left.rules.some((entry) => entry.appId === "dev.everyos.other")).toBe(false);
  });

  it("makes HTTP requests only to allowed targets, without EveryOS credentials", async () => {
    const { ctx, admin, open, host, rule } = await withNetworkApp();
    const upstream = new Upstream();
    upstreams.push(upstream);
    await upstream.start();
    const token = await open(admin);
    const base = `http://127.0.0.1:${upstream.port}`;
    const http = (input: Record<string, unknown>) => host(admin, token, "net.http", input);

    const blocked = await http({ method: "GET", url: `${base}/hello` });
    expect(blocked.status).toBe(403);
    expect(await code(blocked)).toMatchObject({
      code: "DESKTOP_APP_NETWORK_BLOCKED",
      details: { host: "127.0.0.1", port: upstream.port, reason: "policy" },
    });
    expect((await http({ method: "GET", url: `${base}/hello` })).status).toBe(403);
    const refusals = ctx.db.all<{ details: string }>(
      "SELECT details FROM audit_events WHERE action = 'desktop-apps.network.blocked'",
    );
    expect(refusals).toHaveLength(1);
    expect(upstream.seen).toHaveLength(0);

    expect(
      (
        await rule({
          kind: "cidr",
          pattern: "127.0.0.1/32",
          ports: [upstream.port, upstream.closedPort],
        })
      ).status,
    ).toBe(201);
    const hello = await json<{ result: NetHttpResponse }>(
      await http({ method: "GET", url: `${base}/hello` }),
    );
    expect(hello.result).toMatchObject({
      url: `${base}/hello`,
      status: 200,
      remoteAddress: "127.0.0.1",
      body: { encoding: "text", data: '{"hello":"world"}', truncated: false, size: 17 },
      redirects: [],
    });
    expect(hello.result.headers).toContainEqual(["X-Test", "yes"]);
    expect(hello.result.timing.total).toBeGreaterThanOrEqual(hello.result.timing.firstByte);

    const echo = await json<{ result: NetHttpResponse }>(
      await http({
        method: "POST",
        url: `${base}/echo`,
        headers: [
          ["X-Custom", "1"],
          ["Authorization", "Bearer app-token"],
        ],
        body: { text: "payload" },
      }),
    );
    expect(echo.result.status).toBe(201);
    const received = upstream.seen.at(-1)!;
    expect(received.body).toBe("payload");
    expect(received.headers).toMatchObject({
      "x-custom": "1",
      authorization: "Bearer app-token",
      "content-type": "text/plain; charset=utf-8",
      "user-agent": "EveryOS-App/1 (dev.everyos.netprobe)",
    });
    // Nothing of the person's EveryOS session travels with an app's request.
    expect(received.headers.cookie).toBeUndefined();
    expect(JSON.stringify(received.headers)).not.toContain(admin.csrfToken!);
    expect(
      (await http({ method: "GET", url: `${base}/echo`, headers: [["Host", "evil"]] })).status,
    ).toBe(400);
    expect((await http({ method: "GET", url: `file:///etc/passwd` })).status).toBe(400);
    expect(
      (await http({ method: "GET", url: `http://user:pw@127.0.0.1:${upstream.port}/` })).status,
    ).toBe(400);

    const redirect = await json<{ result: NetHttpResponse }>(
      await http({ method: "GET", url: `${base}/redirect` }),
    );
    expect(redirect.result.status).toBe(302);
    const followed = await json<{ result: NetHttpResponse }>(
      await http({ method: "GET", url: `${base}/redirect`, followRedirects: true }),
    );
    expect(followed.result).toMatchObject({
      status: 200,
      url: `${base}/hello`,
      redirects: [{ url: `${base}/redirect`, status: 302 }],
    });
    // Each hop is checked: a redirect cannot lead to a port the policy does not allow.
    await rule({ kind: "cidr", pattern: "127.0.0.1/32", ports: [upstream.port] });
    ctx.db.run(
      "DELETE FROM desktop_app_network_rules WHERE ports = ?",
      JSON.stringify([upstream.port, upstream.closedPort].sort((a, b) => a - b)),
    );
    const away = await http({ method: "GET", url: `${base}/away`, followRedirects: true });
    expect(away.status).toBe(403);
    expect((await code(away)).details).toMatchObject({ port: upstream.closedPort });

    const gzip = await json<{ result: NetHttpResponse }>(
      await http({ method: "GET", url: `${base}/gzip` }),
    );
    expect(gzip.result.body.data).toBe("compressed text ".repeat(100));
    const big = await json<{ result: NetHttpResponse }>(
      await http({ method: "GET", url: `${base}/big` }),
    );
    expect(big.result.body).toMatchObject({ encoding: "base64", truncated: true });
    expect(Buffer.from(big.result.body.data, "base64").length).toBe(2 * 1024 * 1024);

    const slow = await http({ method: "GET", url: `${base}/slow`, timeoutMs: 1000 });
    expect(slow.status).toBe(502);
    expect((await code(slow)).details).toMatchObject({ reason: "timeout" });
    await rule({ kind: "cidr", pattern: "127.0.0.1/32", ports: [upstream.closedPort] });
    const refused = await http({ method: "GET", url: `http://127.0.0.1:${upstream.closedPort}/` });
    expect((await code(refused)).details).toMatchObject({ reason: "refused" });
  }, 30_000);

  it("needs network:outbound granted, and inspects TLS and DNS within the policy", async () => {
    const { admin, open, host, rule } = await withNetworkApp();
    const otherToken = await open(admin, "dev.everyos.other");
    expect(
      (
        await host(admin, otherToken, "net.http", {
          method: "GET",
          url: "https://api.example.com/",
        })
      ).status,
    ).toBe(403);
    expect(
      (await code(await host(admin, otherToken, "net.dns", { name: "example.com", type: "A" })))
        .code,
    ).toBe("FORBIDDEN");

    const dir = await mkdtemp(join(tmpdir(), "everyos-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=everyos-test",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:everyos-test",
      ],
      { stdio: "ignore" },
    );
    const upstream = new Upstream({
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "cert.pem")),
    });
    upstreams.push(upstream);
    await upstream.start();
    const token = await open(admin);
    expect(
      (await host(admin, token, "net.tls", { host: "127.0.0.1", port: upstream.port })).status,
    ).toBe(403);
    await rule({ kind: "cidr", pattern: "127.0.0.1/32", ports: [upstream.port] });
    const tls = await json<{ result: NetTlsResult }>(
      await host(admin, token, "net.tls", { host: "127.0.0.1", port: upstream.port }),
    );
    expect(tls.result).toMatchObject({
      host: "127.0.0.1",
      authorized: false,
      hostnameMatches: true,
      chain: [
        { subject: "CN=everyos-test", issuer: "CN=everyos-test", selfSigned: true, keyType: "ec" },
      ],
    });
    expect(tls.result.chain[0]!.subjectAltNames).toContain("DNS:everyos-test");
    expect(tls.result.chain[0]!.validTo).toBeGreaterThan(Date.now());
    expect(tls.result.protocol).toMatch(/^TLSv1\.[23]$/);
    // The same certificate fails an HTTPS request unless the app explicitly accepts it.
    const strict = await host(admin, token, "net.http", {
      method: "GET",
      url: `https://127.0.0.1:${upstream.port}/hello`,
    });
    expect((await code(strict)).details).toMatchObject({ reason: "tls" });
    const lenient = await json<{ result: NetHttpResponse }>(
      await host(admin, token, "net.http", {
        method: "GET",
        url: `https://127.0.0.1:${upstream.port}/hello`,
        verifyTls: false,
      }),
    );
    expect(lenient.result.status).toBe(200);
    expect(lenient.result.timing.tls).not.toBeNull();

    const dns = await dnsServer({ "printer.home.arpa": "192.168.1.40" });
    try {
      const query = (input: Record<string, unknown>) => host(admin, token, "net.dns", input);
      const server = { server: "127.0.0.1", serverPort: dns.port };
      expect((await query({ name: "printer.home.arpa", type: "A", ...server })).status).toBe(403);
      await rule({ kind: "cidr", pattern: "127.0.0.1/32", ports: [dns.port] });
      const found = await json<{ result: NetDnsResult }>(
        await query({ name: "printer.home.arpa", type: "A", ...server }),
      );
      expect(found.result).toMatchObject({
        status: "ok",
        servers: [`127.0.0.1:${dns.port}`],
        records: [{ type: "A", address: "192.168.1.40", ttl: 300 }],
      });
      const missing = await json<{ result: NetDnsResult }>(
        await query({ name: "nothing.home.arpa", type: "A", ...server }),
      );
      expect(missing.result).toMatchObject({ status: "not-found", records: [] });
      expect((await query({ name: "bad name!", type: "A", ...server })).status).toBe(400);
      expect((await query({ name: "printer.home.arpa", type: "ANY", ...server })).status).toBe(400);
    } finally {
      dns.close();
    }
  }, 30_000);

  it("monitors endpoints on its own schedule and tells only their owner when they fail", async () => {
    const { ctx, admin, operator, open, host, rule } = await withNetworkApp(
      ["network:outbound", "notifications:send"],
      ["network:outbound"],
    );
    const upstream = new Upstream();
    upstreams.push(upstream);
    await upstream.start();
    const token = await open(admin);
    const monitors = ctx.services.desktopApps.monitors;
    const monitor = {
      name: "Home page",
      url: `http://127.0.0.1:${upstream.port}/hello`,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 5000,
      expectStatus: { min: 200, max: 299 },
      keyword: "world",
      downAfter: 1,
      verifyTls: true,
      notify: true,
      enabled: true,
    };
    const save = (input: Record<string, unknown>, as = token) =>
      host(admin, as, "net.monitors.save", input);
    expect(await code(await save(monitor))).toMatchObject({ code: "DESKTOP_APP_NETWORK_BLOCKED" });
    await rule({ kind: "cidr", pattern: "127.0.0.1/32", ports: [upstream.port] });
    const created = (await json<{ result: NetMonitor }>(await save(monitor))).result;
    expect(created).toMatchObject({ state: "pending", checkedAt: null, uptime24h: null });

    await monitors.tick();
    const list = async () =>
      (
        await json<{ result: { monitors: NetMonitor[] } }>(
          await host(admin, token, "net.monitors.list"),
        )
      ).result.monitors;
    expect((await list())[0]).toMatchObject({ state: "up", lastStatus: 200, uptime24h: 1 });
    // Not due yet: no second check.
    await monitors.tick();
    expect(upstream.seen).toHaveLength(1);

    const events = async (client: TestClient) =>
      (
        await json<{
          notifications: Array<{ kind: string; severity: string; params: Record<string, unknown> }>;
        }>(await client.get("/api/notifications"))
      ).notifications.filter((n) => n.kind.startsWith("app-monitor"));
    upstream.failing = true;
    ctx.clock.now += 61_000;
    await monitors.tick();
    expect((await list())[0]).toMatchObject({
      state: "down",
      lastStatus: 500,
      lastError: "status",
      uptime24h: 0.5,
    });
    expect(await events(admin)).toMatchObject([
      {
        kind: "app-monitor-down",
        severity: "warning",
        params: { name: "Home page", target: `127.0.0.1:${upstream.port}` },
      },
    ]);
    expect(await events(operator)).toEqual([]);

    upstream.failing = false;
    // Checking by hand is allowed, at most once every ten seconds.
    expect((await host(admin, token, "net.monitors.check", { id: created.id })).status).toBe(429);
    ctx.clock.now += 11_000;
    const checked = await host(admin, token, "net.monitors.check", { id: created.id });
    expect((await json<{ result: NetMonitor }>(checked)).result.state).toBe("up");
    expect((await host(admin, token, "net.monitors.check", { id: created.id })).status).toBe(429);
    expect((await events(admin)).map((event) => event.kind)).toEqual([
      "app-monitor-recovered",
      "app-monitor-down",
    ]);
    const history = await json<{ result: { checks: NetMonitorCheck[] } }>(
      await host(admin, token, "net.monitors.history", { id: created.id }),
    );
    expect(history.result.checks.map((check) => check.ok)).toEqual([true, false, true]);

    // Another person's app window sees none of it.
    const operatorToken = await open(operator);
    expect(
      (
        await json<{ result: { monitors: NetMonitor[] } }>(
          await host(operator, operatorToken, "net.monitors.list"),
        )
      ).result.monitors,
    ).toEqual([]);
    expect(
      (await host(operator, operatorToken, "net.monitors.delete", { id: created.id })).status,
    ).toBe(404);

    // When the policy no longer allows the target, the monitor says so instead of failing.
    ctx.db.run("DELETE FROM desktop_app_network_rules");
    ctx.clock.now += 61_000;
    await monitors.tick();
    expect((await list())[0]).toMatchObject({ state: "blocked", lastError: "blocked" });
    expect(await events(admin)).toHaveLength(2);

    expect((await host(admin, token, "net.monitors.delete", { id: created.id })).status).toBe(200);
    expect(await list()).toEqual([]);
    expect(
      ctx.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM desktop_app_monitor_checks"),
    ).toEqual({
      count: 0,
    });
  }, 30_000);
});

describe("app databases", () => {
  const as = (token: string) => ({ headers: { "x-everyos-app-instance": token } });
  const servers: Array<{ stop(): Promise<void> }> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
  });

  async function withDatabaseApp() {
    const context = await setup();
    const build = await buildApp(
      "dev.everyos.sql",
      "1.0.0",
      ["database:connect"],
      officialKeys.privateKey,
    );
    const other = await buildApp(
      "dev.everyos.other",
      "1.0.0",
      ["database:connect"],
      officialKeys.privateKey,
    );
    publish(
      context.registry,
      index([
        { id: "dev.everyos.sql", versions: [build] },
        { id: "dev.everyos.other", versions: [other] },
      ]),
      [build, other],
    );
    await sync(context.admin);
    for (const appId of ["dev.everyos.sql", "dev.everyos.other"])
      expect(
        (
          await context.admin.post("/api/desktop-apps/installed", {
            registryId: "official",
            appId,
            approve: ["database:connect"],
          })
        ).status,
      ).toBe(201);
    const open = async (client: TestClient, appId = "dev.everyos.sql") =>
      (
        await json<{ token: string }>(
          await client.post("/api/app-sdk/instances", { appId, kind: "window" }),
        )
      ).token;
    /** As the desktop calls it: `confirmed` only after the person confirmed in its dialog. */
    const host = (
      client: TestClient,
      token: string,
      operation: string,
      input: unknown = null,
      confirmed = false,
    ) =>
      client.request("POST", `/api/app-sdk/host/${operation}`, {
        body: { input, ...(confirmed ? { confirmed: true } : {}) },
        ...as(token),
      });
    return { ...context, open, host };
  }

  it("runs PostgreSQL statements one at a time, read-only unless a confirmed write is allowed", async (test) => {
    const server = await startPostgres();
    if (!server) {
      if (REQUIRE_DB_TESTS) throw new Error("PostgreSQL is required for this test");
      test.skip();
      return;
    }
    servers.push(server);
    const seed = new pg.Client({
      host: "127.0.0.1",
      port: server.port,
      user: server.user,
      password: server.password,
      database: "postgres",
    });
    await seed.connect();
    // A shared server (CI) may hold an earlier run's database.
    await seed.query("DROP DATABASE IF EXISTS shop");
    await seed.query("DROP ROLE IF EXISTS reader");
    await seed.query("CREATE DATABASE shop");
    await seed.end();
    const shop = new pg.Client({
      host: "127.0.0.1",
      port: server.port,
      user: server.user,
      password: server.password,
      database: "shop",
    });
    await shop.connect();
    await shop.query(`
      CREATE TABLE people (id serial PRIMARY KEY, name text NOT NULL, born date, score bigint,
        data jsonb, photo bytea);
      INSERT INTO people (name, born, score, data, photo) VALUES
        ('Ada', '1815-12-10', 9007199254740993, '{"likes": ["maths"]}', '\\xcafe'),
        ('Alan', '1912-06-23', 1, null, null),
        ('Grace', '1906-12-09', 2, null, null);
      CREATE VIEW names AS SELECT name FROM people;
      CREATE ROLE reader LOGIN PASSWORD 'reader-secret';
      GRANT SELECT ON people TO reader;
    `);

    const { ctx, admin, operator, viewer, open, host } = await withDatabaseApp();
    const connection = {
      name: "Shop",
      engine: "postgres",
      host: "127.0.0.1",
      port: server.port,
      database: "shop",
      username: server.user,
      password: server.password,
      tls: "disable",
      access: "read",
      audience: "admins",
      appId: null,
    };
    expect((await operator.post("/api/desktop-apps/db-connections", connection)).status).toBe(403);
    const created = await json<DesktopAppDbConnectionView>(
      await admin.post("/api/desktop-apps/db-connections", connection),
    );
    expect(created).toMatchObject({ name: "Shop", hasPassword: true, access: "read" });
    expect(JSON.stringify(created)).not.toContain(server.password);
    // The password is sealed at rest and never listed.
    const stored = ctx.db.get<{ sealed_password: string }>(
      "SELECT sealed_password FROM desktop_app_db_connections WHERE id = ?",
      created.id,
    )!;
    expect(stored.sealed_password).not.toContain(server.password);
    const listed = await operator.get("/api/desktop-apps/db-connections");
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain(server.password);
    expect((await viewer.get("/api/desktop-apps/db-connections")).status).toBe(403);
    const tested = await json<{ version: string }>(
      await admin.post(`/api/desktop-apps/db-connections/${created.id}/test`, {}),
    );
    expect(tested.version).toContain("PostgreSQL");

    const token = await open(admin);
    const connections = await json<{ result: { connections: Array<Record<string, unknown>> } }>(
      await host(admin, token, "db.connections"),
    );
    expect(connections.result.connections).toEqual([
      {
        id: created.id,
        name: "Shop",
        engine: "postgres",
        host: "127.0.0.1",
        port: server.port,
        database: "shop",
        access: "read",
      },
    ]);
    // Administrators only: the operator's window sees no connection and cannot name it.
    const operatorToken = await open(operator);
    expect(
      (
        await json<{ result: { connections: unknown[] } }>(
          await host(operator, operatorToken, "db.connections"),
        )
      ).result.connections,
    ).toEqual([]);
    expect(
      (
        await host(operator, operatorToken, "db.query", {
          connection: created.id,
          sql: "SELECT 1",
        })
      ).status,
    ).toBe(404);

    const tables = await json<{ result: { tables: DbTable[] } }>(
      await host(admin, token, "db.tables", { connection: created.id }),
    );
    expect(tables.result.tables.map((table) => [table.schema, table.name, table.kind])).toEqual([
      ["public", "names", "view"],
      ["public", "people", "table"],
    ]);
    expect(tables.result.tables[1]!.columns[0]).toEqual({
      name: "id",
      type: "integer",
      nullable: false,
    });

    const query = (input: Record<string, unknown>, confirmed = false) =>
      host(admin, token, "db.query", { connection: created.id, ...input }, confirmed);
    const people = await json<{ result: DbQueryResult }>(
      await query({
        sql: "SELECT id, name, born, score, data, photo FROM people WHERE id = $1",
        params: [1],
      }),
    );
    expect(people.result).toMatchObject({
      command: "SELECT",
      rowCount: 1,
      truncated: false,
      readOnly: true,
      rows: [[1, "Ada", "1815-12-10", "9007199254740993", { likes: ["maths"] }, "\\xcafe"]],
    });
    expect(people.result.columns.map((column) => column.type)).toEqual([
      "int4",
      "text",
      "date",
      "int8",
      "jsonb",
      "bytea",
    ]);

    // Read-only: changes, mode switches and statement batches are all refused.
    const remove = await query({ sql: "DELETE FROM people" });
    expect((await code(remove)).code).toBe("DESKTOP_APP_DB_READ_ONLY");
    expect((await code(await query({ sql: "SET TRANSACTION READ WRITE" }))).details).toMatchObject({
      code: "25001",
    });
    expect(
      (await code(await query({ sql: "SELECT 1; DELETE FROM people" }))).details,
    ).toMatchObject({
      code: "42601",
    });
    // Ending the transaction early ends the read: nothing else runs in that call.
    expect((await query({ sql: "COMMIT" })).status).toBe(200);
    expect((await code(await query({ sql: "DELETE FROM people", write: true }))).code).toBe(
      "DESKTOP_APP_DB_READ_ONLY",
    );
    expect((await shop.query("SELECT count(*)::int AS n FROM people")).rows[0]).toEqual({ n: 3 });

    // Bounded: rows, size and time.
    const many = await json<{ result: DbQueryResult }>(
      await query({ sql: "SELECT g FROM generate_series(1, 2000) g", maxRows: 10 }),
    );
    expect(many.result).toMatchObject({ truncated: true, rowCount: null });
    expect(many.result.rows).toHaveLength(10);
    const slow = await query({ sql: "SELECT pg_sleep(5)", timeoutMs: 1000 });
    expect((await code(slow)).details).toMatchObject({ code: "57014" });

    // A writable connection still needs the person's confirmation for each change.
    const writable = { ...connection, access: "write" };
    delete (writable as { password?: string }).password;
    expect(
      (
        await admin.request("PUT", `/api/desktop-apps/db-connections/${created.id}`, {
          body: writable,
        })
      ).status,
    ).toBe(200);
    const unconfirmed = await query({
      sql: "INSERT INTO people (name) VALUES ('Linus')",
      write: true,
    });
    expect(unconfirmed.status).toBe(403);
    expect((await code(unconfirmed)).details).toMatchObject({ confirmation: "required" });
    const inserted = await json<{ result: DbQueryResult }>(
      await query(
        { sql: "INSERT INTO people (name) VALUES ($1)", params: ["Linus"], write: true },
        true,
      ),
    );
    expect(inserted.result).toMatchObject({ command: "INSERT", rowCount: 1, readOnly: false });
    expect((await shop.query("SELECT count(*)::int AS n FROM people")).rows[0]).toEqual({ n: 4 });
    const audits = ctx.db.all<{ outcome: string; details: string }>(
      "SELECT outcome, details FROM audit_events WHERE action = 'desktop-apps.database.write' ORDER BY id",
    );
    // Refused on the read-only connection, refused unconfirmed, then done.
    expect(audits.map((entry) => entry.outcome)).toEqual(["failure", "failure", "success"]);
    expect(audits[2]!.details).not.toContain("Linus");
    expect(JSON.parse(audits[2]!.details)).toMatchObject({ command: "INSERT", rowCount: 1 });
    // Reads on a writable connection stay read-only.
    expect((await code(await query({ sql: "DELETE FROM people" }))).code).toBe(
      "DESKTOP_APP_DB_READ_ONLY",
    );

    // The database's own privileges still apply, and a wrong password says so.
    const reader = await json<DesktopAppDbConnectionView>(
      await admin.post("/api/desktop-apps/db-connections", {
        ...connection,
        name: "Shop (reader)",
        username: "reader",
        password: "reader-secret",
        access: "write",
        appId: "dev.everyos.sql",
      }),
    );
    const denied = await host(
      admin,
      token,
      "db.query",
      { connection: reader.id, sql: "DELETE FROM people", write: true },
      true,
    );
    expect((await code(denied)).details).toMatchObject({ code: "42501" });
    expect(
      (
        await admin.request("PUT", `/api/desktop-apps/db-connections/${reader.id}`, {
          body: {
            ...connection,
            name: "Shop (reader)",
            username: "reader",
            password: "wrong",
            appId: "dev.everyos.sql",
          },
        })
      ).status,
    ).toBe(200);
    const wrong = await host(admin, token, "db.test", { connection: reader.id });
    expect((await code(wrong)).details).toMatchObject({ code: "28P01" });

    // A connection for one app is invisible to another, and goes with its app.
    const otherToken = await open(admin, "dev.everyos.other");
    const otherList = await json<{ result: { connections: Array<{ id: string }> } }>(
      await host(admin, otherToken, "db.connections"),
    );
    expect(otherList.result.connections.map((entry) => entry.id)).toEqual([created.id]);
    expect(
      (
        await admin.delete("/api/desktop-apps/installed/dev.everyos.sql", {
          body: { confirm: true },
        })
      ).status,
    ).toBe(204);
    expect(
      ctx.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM desktop_app_db_connections"),
    ).toEqual({ count: 1 });
    await shop.end();
  }, 60_000);

  it("keeps MariaDB sessions read-only, single-statement and away from local files", async (test) => {
    const server = await startMysql();
    if (!server) {
      if (REQUIRE_DB_TESTS) throw new Error("MariaDB or MySQL is required for this test");
      test.skip();
      return;
    }
    servers.push(server);
    const mysql = await import("mysql2/promise");
    const seed = await mysql.createConnection({
      host: server.host,
      port: server.port,
      user: server.user,
      password: server.password,
      multipleStatements: true,
    });
    await seed.query(`
      DROP DATABASE IF EXISTS shop;
      CREATE DATABASE shop;
      CREATE TABLE shop.people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL,
        born DATE, score BIGINT);
      INSERT INTO shop.people (name, born, score) VALUES ('Ada', '1815-12-10', 9007199254740993),
        ('Alan', '1912-06-23', 1);
    `);
    const { admin, open, host } = await withDatabaseApp();
    const created = await json<DesktopAppDbConnectionView>(
      await admin.post("/api/desktop-apps/db-connections", {
        name: "Shop",
        engine: "mysql",
        host: server.host,
        port: server.port,
        database: "shop",
        username: server.user,
        password: server.password,
        tls: "disable",
        access: "read",
        audience: "everyone",
        appId: null,
      }),
    );
    const token = await open(admin);
    const query = (input: Record<string, unknown>, confirmed = false) =>
      host(admin, token, "db.query", { connection: created.id, ...input }, confirmed);
    const people = await json<{ result: DbQueryResult }>(
      await query({ sql: "SELECT id, name, born, score FROM people WHERE id = ?", params: [1] }),
    );
    expect(people.result.rows).toEqual([[1, "Ada", "1815-12-10", "9007199254740993"]]);
    const tables = await json<{ result: { tables: DbTable[] } }>(
      await host(admin, token, "db.tables", { connection: created.id }),
    );
    expect(tables.result.tables.map((table) => table.name)).toEqual(["people"]);

    for (const sql of ["DELETE FROM people", "CREATE TABLE intruder (a INT)", "DROP TABLE people"])
      expect((await code(await query({ sql }))).code, sql).toBe("DESKTOP_APP_DB_READ_ONLY");
    expect((await code(await query({ sql: "SELECT 1; DELETE FROM people" }))).code).toBe(
      "DESKTOP_APP_DB_FAILED",
    );
    // A server cannot make EveryOS read its own files.
    const infile = await query({
      sql: "LOAD DATA LOCAL INFILE '/etc/hosts' INTO TABLE people",
      write: true,
    });
    expect(infile.status).toBe(403);
    const [count] = (await seed.query("SELECT COUNT(*) AS n FROM shop.people")) as unknown as [
      Array<{ n: number }>,
    ];
    expect(count[0]!.n).toBe(2);
    const many = await json<{ result: DbQueryResult }>(
      await query({
        sql: "SELECT seq FROM (SELECT a.id * 1000 + b.id AS seq FROM people a, people b, people c, people d) x",
        maxRows: 3,
      }),
    );
    expect(many.result).toMatchObject({ truncated: true });
    expect(many.result.rows).toHaveLength(3);
    await seed.end();
  }, 60_000);
});
