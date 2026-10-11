import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { ApiErrorBody, SessionInfo, WallpaperInfo } from "@everyos/shared";
import type { AppearancePreferences, PreferenceDocuments } from "@everyos/shared/schemas";
import { describe, expect, it } from "vitest";
import { probeImage } from "./modules/wallpapers/image-probe.ts";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TestClient,
} from "./test-support.ts";

const errorCode = async (response: Response) => (await json<ApiErrorBody>(response)).error.code;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable RGB PNG of the given size. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x55)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Header-only PNG declaring arbitrary dimensions. */
function pngHeader(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ]);
}

const appearance: AppearancePreferences = {
  version: 1,
  themeId: "aurora",
  accent: "#ff8800",
  effects: { blur: 12 },
  fontScale: 1,
  iconSize: "medium",
  renderMode: "balanced",
  windowAnimation: "scale",
  wallpaper: { kind: "preset", id: "aurora" },
  wallpaperAnimated: true,
  customThemes: [],
};

async function admin() {
  const ctx = await createTestContext();
  const client = new TestClient(ctx);
  await completeSetup(ctx, client);
  return { ctx, client };
}

describe("preferences API", () => {
  it("loads legacy app and wallpaper identifiers without dropping saved preferences", async () => {
    const { ctx, client } = await admin();
    const userId = ctx.db.get<{ id: string }>("SELECT id FROM users WHERE username='admin'")!.id;
    ctx.services.preferences.set(userId, "appearance", {
      ...appearance,
      wallpaper: { kind: "preset", id: "otuken-dusk" },
    });
    ctx.services.preferences.set(userId, "dock", {
      version: 1,
      pinned: ["otuken.files", "otuken.settings"],
      style: "floating",
      position: "bottom",
      iconSize: 48,
      magnification: true,
      autoHide: false,
      opacity: 0.8,
    });
    const stored = await json<{ preferences: Partial<PreferenceDocuments> }>(
      await client.get("/api/preferences"),
    );
    expect(stored.preferences.appearance?.wallpaper).toEqual({
      kind: "preset",
      id: "everyos-dusk",
    });
    expect(stored.preferences.dock?.pinned).toEqual(["everyos.files", "everyos.settings"]);
  });

  it("stores validated documents per user", async () => {
    const { ctx, client } = await admin();
    expect(await json(await client.get("/api/preferences"))).toEqual({ preferences: {} });
    expect(
      (await client.request("PUT", "/api/preferences/appearance", { body: appearance })).status,
    ).toBe(204);
    const stored = await json<{ preferences: Partial<PreferenceDocuments> }>(
      await client.get("/api/preferences"),
    );
    expect(stored.preferences.appearance).toEqual(appearance);

    await client.post("/api/users", {
      username: "ikinci",
      displayName: "İkinci",
      password: STRONG_PASSWORD,
      role: "viewer",
    });
    const other = new TestClient(ctx, "192.0.2.5");
    await other.login("ikinci", STRONG_PASSWORD);
    expect(await json(await other.get("/api/preferences"))).toEqual({ preferences: {} });

    expect((await client.delete("/api/preferences/appearance")).status).toBe(204);
    expect(await json(await client.get("/api/preferences"))).toEqual({ preferences: {} });
  });

  it("rejects unknown keys, invalid documents and dangling theme references", async () => {
    const { client } = await admin();
    expect((await client.request("PUT", "/api/preferences/secrets", { body: {} })).status).toBe(
      404,
    );
    const extra = await client.request("PUT", "/api/preferences/appearance", {
      body: { ...appearance, script: "x" },
    });
    expect(await errorCode(extra)).toBe("VALIDATION_FAILED");
    const badColor = await client.request("PUT", "/api/preferences/appearance", {
      body: { ...appearance, accent: "red;}body{display:none" },
    });
    expect(await errorCode(badColor)).toBe("VALIDATION_FAILED");
    const dangling = await client.request("PUT", "/api/preferences/appearance", {
      body: { ...appearance, themeId: "custom:missing" },
    });
    expect(await errorCode(dangling)).toBe("VALIDATION_FAILED");
    const custom = await client.request("PUT", "/api/preferences/appearance", {
      body: {
        ...appearance,
        themeId: "custom:mine",
        customThemes: [
          {
            id: "mine",
            name: "Benim",
            base: "liquid-dark",
            accent: "#33ccff",
            effects: {},
            wallpaper: null,
          },
        ],
      },
    });
    expect(custom.status).toBe(204);
  });

  it("validates the window session and desktop documents", async () => {
    const { client } = await admin();
    const session = {
      version: 1,
      viewport: { width: 1440, height: 900 },
      activeDesktopId: "d1",
      windows: [
        {
          id: "w1",
          appId: "everyos.settings",
          desktopId: "d1",
          title: "Ayarlar",
          bounds: { x: 100, y: 80, width: 800, height: 600 },
          layout: "left",
          minimized: false,
          z: 3,
          appState: { section: "appearance" },
        },
      ],
    };
    expect(
      (await client.request("PUT", "/api/preferences/windows", { body: session })).status,
    ).toBe(204);
    const badLayout = { ...session, windows: [{ ...session.windows[0], layout: "sideways" }] };
    expect(
      (await client.request("PUT", "/api/preferences/windows", { body: badLayout })).status,
    ).toBe(400);
    const desktop = {
      version: 1,
      desktops: [{ id: "d1", name: "Ana", wallpaper: null }],
      items: [
        {
          kind: "app",
          id: "i1",
          appId: "everyos.system",
          desktopId: "d1",
          cell: { col: 0, row: 0 },
          folderId: null,
        },
        { kind: "folder", id: "f1", name: "Araçlar", desktopId: "d1", cell: { col: 0, row: 1 } },
      ],
    };
    expect(
      (await client.request("PUT", "/api/preferences/desktop", { body: desktop })).status,
    ).toBe(204);
    const noDesktops = { ...desktop, desktops: [] };
    expect(
      (await client.request("PUT", "/api/preferences/desktop", { body: noDesktops })).status,
    ).toBe(400);
  });

  it("requires authentication and the CSRF token", async () => {
    const { ctx, client } = await admin();
    expect((await new TestClient(ctx).get("/api/preferences")).status).toBe(401);
    const token = client.csrfToken;
    client.csrfToken = null;
    expect(
      (await client.request("PUT", "/api/preferences/appearance", { body: appearance })).status,
    ).toBe(403);
    client.csrfToken = token;
  });

  it("rejects unexpected queries and records changes to session security", async () => {
    const { ctx, client } = await admin();
    expect((await client.get("/api/preferences?userId=another-user")).status).toBe(400);
    expect((await client.get("/api/wallpapers?userId=another-user")).status).toBe(400);
    expect((await client.get("/api/wallpapers/bad.id/image")).status).toBe(400);
    expect(
      (
        await client.request("PUT", "/api/preferences/security", {
          body: { version: 1, autoLockMinutes: 5 },
        })
      ).status,
    ).toBe(204);
    expect((await client.delete("/api/preferences/security")).status).toBe(204);
    const events = ctx.db.all<{ action: string }>(
      "SELECT action FROM audit_events ORDER BY id DESC LIMIT 20",
    );
    expect(events.map((event) => event.action)).toContain("preferences.security.update");
    expect(events.map((event) => event.action)).toContain("preferences.security.reset");
  });
});

describe("session locking", () => {
  it("rejects unexpected lock inputs without changing the session", async () => {
    const { client } = await admin();
    expect((await client.post("/api/auth/lock", { userId: "other" })).status).toBe(400);
    expect((await client.post("/api/auth/lock?sessionId=other")).status).toBe(400);
    const session = await json<SessionInfo>(await client.get("/api/auth/session"));
    expect(session.session.locked).toBe(false);
  });

  it("is enforced by the server until the password is re-entered", async () => {
    const { client } = await admin();
    expect((await client.post("/api/auth/lock")).status).toBe(204);
    const locked = await json<SessionInfo>(await client.get("/api/auth/session"));
    expect(locked.session.locked).toBe(true);

    const blocked = await client.get("/api/system/info");
    expect(blocked.status).toBe(423);
    expect(await errorCode(blocked)).toBe("SESSION_LOCKED");
    expect((await client.get("/api/users")).status).toBe(423);
    expect((await client.get("/api/bootstrap")).status).toBe(200);
    expect((await client.get("/api/health")).status).toBe(200);
    expect(
      (await client.request("PUT", "/api/preferences/appearance", { body: appearance })).status,
    ).toBe(423);
    expect((await client.get("/api/preferences")).status).toBe(200);

    const wrong = await client.post("/api/auth/unlock", { password: "yanlis-parola-1" });
    expect(await errorCode(wrong)).toBe("AUTH_INVALID_CREDENTIALS");
    const unlocked = await client.post("/api/auth/unlock", { password: STRONG_PASSWORD });
    expect((await json<SessionInfo>(unlocked)).session.locked).toBe(false);
    expect((await client.get("/api/system/info")).status).toBe(200);
  });

  it("only locks the session that asked for it", async () => {
    const { ctx, client } = await admin();
    const laptop = new TestClient(ctx, "192.0.2.9");
    await laptop.login("admin", STRONG_PASSWORD);
    await client.post("/api/auth/lock");
    expect((await laptop.get("/api/system/info")).status).toBe(200);
    // Logging out from a locked session is still possible.
    expect((await client.post("/api/auth/logout")).status).toBe(204);
  });

  it("rate-limits unlock attempts", async () => {
    const { client } = await admin();
    await client.post("/api/auth/lock");
    for (let i = 0; i < 5; i++)
      await client.post("/api/auth/unlock", { password: "yanlis-parola-1" });
    expect((await client.post("/api/auth/unlock", { password: STRONG_PASSWORD })).status).toBe(429);
  });
});

describe("folder icons API", () => {
  const upload = (client: TestClient, data: Uint8Array, type = "image/png") =>
    client.request("POST", "/api/folder-icons", {
      rawBody: data,
      headers: { "content-type": type },
    });

  it("isolates owned icons, validates references and protects icons still used by folders", async () => {
    const { ctx, client } = await admin();
    const image = png(32, 32);
    const uploaded = await upload(client, image);
    expect(uploaded.status).toBe(201);
    const info = await json<WallpaperInfo>(uploaded);
    expect(await json(await client.get("/api/folder-icons"))).toEqual({ icons: [info] });
    expect(await json(await client.get("/api/wallpapers"))).toEqual({ wallpapers: [] });
    expect((await client.get(`/api/wallpapers/${info.id}/image`)).status).toBe(404);
    const served = await client.get(`/api/folder-icons/${info.id}/image`);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("private");
    expect(Buffer.from(await served.arrayBuffer())).toEqual(image);
    const configured = {
      ...appearance,
      folderIcon: { kind: "preset", id: "green" },
      folderIcons: [
        { root: "home", path: "Desktop/Work", icon: { kind: "uploaded", iconId: info.id } },
      ],
    };
    expect(
      (await client.request("PUT", "/api/preferences/appearance", { body: configured })).status,
    ).toBe(204);
    expect((await client.delete(`/api/folder-icons/${info.id}`)).status).toBe(409);
    expect((await client.delete(`/api/wallpapers/${info.id}`)).status).toBe(404);
    await client.post("/api/users", {
      username: "iconviewer",
      displayName: "Icon viewer",
      password: STRONG_PASSWORD,
      role: "viewer",
    });
    const other = new TestClient(ctx, "192.0.2.19");
    await other.login("iconviewer", STRONG_PASSWORD);
    expect((await other.get(`/api/folder-icons/${info.id}/image`)).status).toBe(404);
    expect(
      (await other.request("PUT", "/api/preferences/appearance", { body: configured })).status,
    ).toBe(400);
    expect((await other.delete(`/api/folder-icons/${info.id}`)).status).toBe(404);
    expect(
      (
        await client.request("PUT", "/api/preferences/appearance", {
          body: {
            ...configured,
            folderIcons: [...configured.folderIcons, ...configured.folderIcons],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await client.request("PUT", "/api/preferences/appearance", {
          body: {
            ...configured,
            folderIcons: [{ ...configured.folderIcons[0], path: "../outside" }],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await client.request("PUT", "/api/preferences/appearance", { body: appearance })).status,
    ).toBe(204);
    expect((await client.delete(`/api/folder-icons/${info.id}`)).status).toBe(204);
    expect(
      ctx.db
        .all<{ action: string }>("SELECT action FROM audit_events")
        .map((event) => event.action),
    ).toEqual(expect.arrayContaining(["folder-icons.upload", "folder-icons.delete"]));
  });

  it("bounds streamed size and dimensions and rejects active image formats and unexpected queries", async () => {
    const { ctx, client } = await admin();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect((await upload(client, svg, "image/svg+xml")).status).toBe(415);
    expect((await upload(client, svg)).status).toBe(400);
    expect((await upload(client, pngHeader(1025, 32))).status).toBe(400);
    expect((await upload(client, Buffer.alloc(2 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await client.get("/api/folder-icons?userId=other")).status).toBe(400);
    expect((await new TestClient(ctx).get("/api/folder-icons")).status).toBe(401);
    expect(await json(await client.get("/api/folder-icons"))).toEqual({ icons: [] });
  });
});

describe("wallpapers API", () => {
  const upload = (client: TestClient, data: Uint8Array, type = "image/png") =>
    client.request("POST", "/api/wallpapers", { rawBody: data, headers: { "content-type": type } });

  it("stores a verified image, serves it privately and deletes it", async () => {
    const { ctx, client } = await admin();
    const image = png(4, 3);
    const response = await upload(client, image);
    expect(response.status).toBe(201);
    const info = await json<WallpaperInfo>(response);
    expect(info).toMatchObject({ mime: "image/png", width: 4, height: 3, size: image.length });

    const list = await json<{ wallpapers: WallpaperInfo[] }>(await client.get("/api/wallpapers"));
    expect(list.wallpapers.map((w) => w.id)).toEqual([info.id]);

    const served = await client.get(`/api/wallpapers/${info.id}/image`);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("private");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await served.arrayBuffer()).equals(image)).toBe(true);

    await client.post("/api/users", {
      username: "baskasi",
      displayName: "B",
      password: STRONG_PASSWORD,
      role: "admin",
    });
    const other = new TestClient(ctx, "192.0.2.7");
    await other.login("baskasi", STRONG_PASSWORD);
    expect((await other.get(`/api/wallpapers/${info.id}/image`)).status).toBe(404);
    expect((await other.delete(`/api/wallpapers/${info.id}`)).status).toBe(404);

    expect((await client.delete(`/api/wallpapers/${info.id}`)).status).toBe(204);
    expect((await client.get(`/api/wallpapers/${info.id}/image`)).status).toBe(404);
  });

  it("rejects content that is not really an image", async () => {
    const { client } = await admin();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(await errorCode(await upload(client, svg, "image/png"))).toBe("WALLPAPER_INVALID");
    expect((await upload(client, svg, "image/svg+xml")).status).toBe(415);
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect((await upload(client, html, "text/html")).status).toBe(415);
    expect(await errorCode(await upload(client, Buffer.alloc(0), "image/jpeg"))).toBe(
      "WALLPAPER_INVALID",
    );
  });

  it("enforces size, dimension and count limits", async () => {
    const { ctx, client } = await admin();
    const huge = Buffer.concat([pngHeader(100, 100), Buffer.alloc(10 * 1024 * 1024)]);
    expect((await upload(client, huge)).status).toBe(413);
    expect(await errorCode(await upload(client, pngHeader(9000, 10)))).toBe("WALLPAPER_INVALID");
    for (let i = 0; i < 20; i++) expect((await upload(client, png(1, 1))).status).toBe(201);
    expect(await errorCode(await upload(client, png(1, 1)))).toBe("WALLPAPER_QUOTA_EXCEEDED");
    // No temporary files are left behind by rejected uploads.
    const userDir = readdirSync(join(ctx.config.paths.dataDir, "wallpapers"))[0]!;
    const files = readdirSync(join(ctx.config.paths.dataDir, "wallpapers", userDir));
    expect(files.filter((f) => f.startsWith(".upload-"))).toEqual([]);
    expect(files).toHaveLength(20);
  });

  it("removes a user's files when the account is deleted", async () => {
    const { ctx, client } = await admin();
    const created = await json<{ id: string }>(
      await client.post("/api/users", {
        username: "gecici",
        displayName: "G",
        password: STRONG_PASSWORD,
        role: "viewer",
      }),
    );
    const temp = new TestClient(ctx, "192.0.2.8");
    await temp.login("gecici", STRONG_PASSWORD);
    expect((await upload(temp, png(2, 2))).status).toBe(201);
    const dir = join(ctx.config.paths.dataDir, "wallpapers", created.id);
    expect(existsSync(dir)).toBe(true);
    expect((await client.delete(`/api/users/${created.id}`)).status).toBe(204);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("image probe", () => {
  it("reads PNG dimensions", () => {
    expect(probeImage(png(7, 5))).toEqual({ mime: "image/png", width: 7, height: 5 });
  });

  it("reads JPEG dimensions past APP segments", () => {
    const app0 = Buffer.from([
      0xff,
      0xe0,
      0x00,
      0x10,
      ...Buffer.from("JFIF\0"),
      1,
      1,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
    ]);
    const sof0 = Buffer.from([
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11,
      1,
    ]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]);
    expect(probeImage(jpeg)).toEqual({ mime: "image/jpeg", width: 800, height: 600 });
  });

  it("reads WebP (VP8X) dimensions", () => {
    const webp = Buffer.alloc(40);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(1919, 24, 3);
    webp.writeUIntLE(1079, 27, 3);
    expect(probeImage(webp)).toEqual({ mime: "image/webp", width: 1920, height: 1080 });
  });

  it("rejects everything else", () => {
    expect(probeImage(Buffer.from("GIF89a......"))).toBeNull();
    expect(probeImage(Buffer.from("<svg></svg>"))).toBeNull();
    expect(probeImage(Buffer.alloc(64))).toBeNull();
  });
});
