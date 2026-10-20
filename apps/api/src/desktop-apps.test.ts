import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import {
  generatePublisherKeys,
  keyFingerprint,
  packDirectory,
  sha256Hex,
  signPackage,
} from "@everyos/app-package";
import { signRegistryIndex, type RegistryIndex } from "@everyos/app-registry";
import { createCatalogFetcher } from "@everyos/catalogs";
import type {
  ApiErrorBody,
  DesktopAppInstallationView,
  DesktopAppListing,
  DesktopAppRegistryView,
} from "@everyos/shared";
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

async function setup(): Promise<{
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
