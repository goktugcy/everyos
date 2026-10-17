import type {
  DriveAccountView,
  DriveClientView,
  DriveListing,
  FileListing,
  TransferView,
} from "@everyos/shared";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGoogle, type FakeGoogle } from "./modules/drive/fake-google.ts";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TestClient,
  type TestContext,
} from "./test-support.ts";

const CLIENT = {
  clientId: "123-abc.apps.googleusercontent.com",
  clientSecret: "GOCSPX-fake-secret",
};
let google: FakeGoogle | null = null;
afterEach(async () => {
  await google?.close();
  google = null;
});

async function setup() {
  google = await startFakeGoogle();
  const ctx = await createTestContext({ services: { google: google.endpoints } });
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  return { ctx, admin, google };
}

/** Connects the client's Drive the way a browser would: consent, then back with the code. */
async function connect(client: TestClient) {
  const { url } = await json<{ url: string }>(
    await client.post("/api/drive/connect", { redirectUri: "http://127.0.0.1:7470/" }),
  );
  const consent = await fetch(url, { redirect: "manual" });
  const back = new URL(consent.headers.get("location")!);
  return client.post("/api/drive/connect/complete", {
    code: back.searchParams.get("code"),
    state: back.searchParams.get("state"),
  });
}

async function finished(ctx: TestContext, userId: string): Promise<TransferView[]> {
  for (let i = 0; i < 200; i++) {
    const list = ctx.services.transfers.list(userId);
    if (list.length && list.every((job) => job.state !== "queued" && job.state !== "running"))
      return list;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Transfers did not finish");
}

describe("google drive", () => {
  it("keeps the client secret on the server and only administrators change the client", async () => {
    const { admin, ctx } = await setup();
    expect((await json<DriveAccountView>(await admin.get("/api/drive/account"))).configured).toBe(
      false,
    );
    expect(
      (await admin.post("/api/drive/connect", { redirectUri: "http://127.0.0.1:7470/" })).status,
    ).toBe(409);
    // A new client needs its secret.
    expect(
      (await admin.request("PUT", "/api/drive/client", { body: { clientId: CLIENT.clientId } }))
        .status,
    ).toBe(422);
    const saved = await admin.request("PUT", "/api/drive/client", { body: CLIENT });
    expect(await json<DriveClientView>(saved)).toEqual({
      configured: true,
      clientId: CLIENT.clientId,
    });
    expect(await (await admin.get("/api/drive/client")).text()).not.toContain(CLIENT.clientSecret);
    // Saving the same client again without a secret keeps it.
    expect(
      (await admin.request("PUT", "/api/drive/client", { body: { clientId: CLIENT.clientId } }))
        .status,
    ).toBe(200);
    const stored = ctx.db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = 'drive.client'",
    );
    expect(stored?.value).not.toContain(CLIENT.clientSecret);
    // Non-loopback redirects are refused.
    expect(
      (await admin.post("/api/drive/connect", { redirectUri: "https://evil.example/" })).status,
    ).toBe(400);

    await admin.post("/api/users", {
      username: "viewer",
      displayName: "Viewer",
      password: STRONG_PASSWORD,
      role: "viewer",
    });
    const viewer = new TestClient(ctx, "192.0.2.11");
    await viewer.login("viewer", STRONG_PASSWORD);
    expect((await viewer.get("/api/drive/client")).status).toBe(403);
  });

  it("connects a person's Drive with PKCE, browses it and stores only a sealed refresh token", async () => {
    const { admin, ctx, google } = await setup();
    await admin.request("PUT", "/api/drive/client", { body: CLIENT });
    const docs = google.add({ name: "Belgeler" });
    google.add({ name: "rapor.pdf", parent: docs, content: "%PDF-1.7 fake" });
    google.add({ name: "plan", parent: docs, mimeType: "application/vnd.google-apps.document" });
    google.add({ name: "form", parent: docs, mimeType: "application/vnd.google-apps.form" });
    google.add({ name: "paylasilan.txt", content: "shared", shared: true });

    const connected = await json<DriveAccountView>(await connect(admin));
    expect(connected.account).toMatchObject({
      email: "owner@example.com",
      status: "connected",
      quota: { usedBytes: 1073741824, limitBytes: 16106127360 },
    });
    const row = ctx.db.get<{ sealed_token: string }>("SELECT sealed_token FROM drive_accounts");
    expect(row?.sealed_token.startsWith("v1.")).toBe(true);
    expect(row?.sealed_token).not.toContain("refresh-");
    const root = await json<DriveListing>(await admin.get("/api/drive/files"));
    expect(root.entries.map((entry) => entry.name)).toEqual(["Belgeler"]);
    const folder = await json<DriveListing>(await admin.get(`/api/drive/files?folder=${docs}`));
    expect(folder.path.map((step) => step.name)).toEqual(["My Drive", "Belgeler"]);
    expect(folder.entries.map((entry) => [entry.name, entry.exportAs, entry.downloadable])).toEqual(
      [
        ["form", null, false],
        ["plan", "docx", true],
        ["rapor.pdf", null, true],
      ],
    );
    const shared = await json<DriveListing>(await admin.get("/api/drive/files?folder=shared"));
    expect(shared.entries.map((entry) => entry.name)).toEqual(["paylasilan.txt"]);
    // A file straight to the browser.
    const pdf = folder.entries.find((entry) => entry.name === "rapor.pdf")!;
    const download = await admin.get(`/api/drive/files/${pdf.id}/download`);
    expect(download.headers.get("content-disposition")).toContain("rapor.pdf");
    expect(await download.text()).toBe("%PDF-1.7 fake");
    const form = folder.entries.find((entry) => entry.name === "form")!;
    expect((await admin.get(`/api/drive/files/${form.id}/download`)).status).toBe(409);
  });

  it("copies Drive folders into EveryOS and EveryOS folders into Drive as transfers", async () => {
    const { admin, ctx, google } = await setup();
    await admin.request("PUT", "/api/drive/client", { body: CLIENT });
    await connect(admin);
    const me = await json<{ user: { id: string } }>(await admin.get("/api/auth/session"));
    const trip = google.add({ name: "Tatil" });
    google.add({ name: "deniz.jpg", parent: trip, content: Buffer.alloc(300_000, 7) });
    // Drive allows equal names; each folder keeps its own contents.
    const a = google.add({ name: "Gün", parent: trip });
    const b = google.add({ name: "Gün", parent: trip });
    google.add({ name: "a.txt", parent: a, content: "A" });
    google.add({ name: "b.txt", parent: b, content: "B" });
    google.add({ name: "notlar", parent: trip, mimeType: "application/vnd.google-apps.document" });

    const started = await admin.post("/api/drive/transfers", {
      source: { kind: "drive", id: trip },
      destination: { kind: "files", root: "home", path: "" },
    });
    expect(started.status).toBe(202);
    const [done] = await finished(ctx, me.user.id);
    expect(done).toMatchObject({
      state: "done",
      direction: "download",
      name: "Tatil",
      itemsDone: 4,
    });
    const list = async (path: string) =>
      (
        await json<FileListing>(
          await admin.get(`/api/files/list?root=home&path=${encodeURIComponent(path)}`),
        )
      ).entries
        .map((entry) => entry.name)
        .sort();
    expect(await list("Tatil")).toEqual(["Gün", "Gün (2)", "deniz.jpg", "notlar.docx"]);
    expect([...(await list("Tatil/Gün")), ...(await list("Tatil/Gün (2)"))]).toEqual([
      "a.txt",
      "b.txt",
    ]);
    const text = await admin.get(
      `/api/files/text?root=home&path=${encodeURIComponent("Tatil/notlar.docx")}`,
    );
    expect(text.status === 200 || text.status === 415).toBe(true);

    // The copy goes back up into a new Drive folder.
    ctx.services.transfers.clear(me.user.id);
    expect(
      (
        await admin.post("/api/drive/transfers", {
          source: { kind: "files", root: "home", path: "Tatil" },
          destination: { kind: "drive", id: "root" },
        })
      ).status,
    ).toBe(202);
    const [up] = await finished(ctx, me.user.id);
    expect(up).toMatchObject({ state: "done", direction: "upload", itemsDone: 4 });
    const copies = [...google.files.values()].filter((file) => file.name === "Tatil");
    expect(copies).toHaveLength(2);
    const sea = [...google.files.values()].filter((file) => file.name === "deniz.jpg");
    expect(sea.map((file) => file.content?.length)).toEqual([300_000, 300_000]);

    // A browser upload into Drive streams through.
    const upload = await admin.request(
      "POST",
      "/api/drive/upload?parent=root&name=from-browser.txt",
      {
        rawBody: "hello drive",
        headers: { "content-length": "11" },
      },
    );
    expect(upload.status).toBe(201);
    expect(
      [...google.files.values()]
        .find((file) => file.name === "from-browser.txt")
        ?.content?.toString(),
    ).toBe("hello drive");
  });

  it("asks to reconnect when Google no longer accepts the authorization, and disconnects", async () => {
    const { admin, google } = await setup();
    await admin.request("PUT", "/api/drive/client", { body: CLIENT });
    await connect(admin);
    google.revokeAll();
    const refused = await admin.get("/api/drive/files");
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("DRIVE_RECONNECT_REQUIRED");
    expect(
      (await json<DriveAccountView>(await admin.get("/api/drive/account"))).account?.status,
    ).toBe("reconnect");
    // Connecting again restores it.
    expect((await json<DriveAccountView>(await connect(admin))).account?.status).toBe("connected");
    expect((await admin.request("DELETE", "/api/drive/account", {})).status).toBe(204);
    expect(
      (await json<DriveAccountView>(await admin.get("/api/drive/account"))).account,
    ).toBeNull();
    expect((await admin.get("/api/drive/files")).status).toBe(409);
  });
});
