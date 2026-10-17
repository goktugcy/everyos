import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import type { NotificationChannelView } from "@everyos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderNotification } from "./modules/notifications/channels.ts";
import {
  completeSetup,
  createTestContext,
  json,
  STRONG_PASSWORD,
  TestClient,
  type TestContext,
} from "./test-support.ts";

interface Received {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}
const servers: Server[] = [],
  contexts: TestContext[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const ctx of contexts.splice(0)) {
    ctx.services.apps.stop();
    ctx.services.docker.stop();
    ctx.services.metrics.stop();
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

/** A webhook/ntfy/Telegram look-alike that records what it receives. */
async function fixture(status = 200) {
  const received: Received[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part as Buffer);
    received.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(parts).toString() || "{}") as Record<string, unknown>,
    });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(status === 204 ? undefined : '{"ok":true}');
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

async function setup(options: { telegram?: string } = {}) {
  const mails: Array<{ options: Record<string, unknown>; mail: Record<string, unknown> }> = [];
  const ctx = await createTestContext({
    services: {
      smtp: (transport) => ({
        sendMail: (mail) => {
          mails.push({ options: transport, mail });
          return Promise.resolve({});
        },
      }),
      ...(options.telegram ? { telegramApi: options.telegram } : {}),
    },
  });
  contexts.push(ctx);
  const admin = new TestClient(ctx);
  await completeSetup(ctx, admin);
  await admin.post("/api/users", {
    username: "operator",
    displayName: "Operator",
    password: STRONG_PASSWORD,
    role: "operator",
  });
  const operator = new TestClient(ctx, "192.0.2.10");
  await operator.login("operator", STRONG_PASSWORD);
  return { ctx, admin, operator, mails };
}

const common = {
  name: "Phone",
  enabled: true,
  minSeverity: "info",
  categories: [],
  language: "tr",
} as const;

describe("notification channels", () => {
  it("are administrator-only and never return credentials or topic names", async () => {
    const { ctx, admin, operator } = await setup();
    const ntfy = await fixture();
    expect((await operator.get("/api/notification-channels")).status).toBe(403);
    const created = await admin.post("/api/notification-channels", {
      ...common,
      kind: "ntfy",
      server: ntfy.url,
      topic: "everyos-private-topic",
      token: "tk_private_token",
    });
    expect(created.status).toBe(201);
    const view = await json<NotificationChannelView>(created);
    expect(view.settings).toEqual({ kind: "ntfy", server: ntfy.url, topicHint: "eve…" });
    expect(view.hasSecret).toBe(true);
    const listing = await (await admin.get("/api/notification-channels")).text();
    for (const secret of ["everyos-private-topic", "tk_private_token"]) {
      expect(listing).not.toContain(secret);
      expect(JSON.stringify(ctx.db.all("SELECT * FROM notification_channels"))).not.toContain(
        secret,
      );
      expect(JSON.stringify(ctx.db.all("SELECT * FROM audit_events"))).not.toContain(secret);
    }
    // Test messages go out in the channel's language, as ntfy JSON with the token.
    expect((await admin.post(`/api/notification-channels/${view.id}/test`, {})).status).toBe(200);
    expect(ntfy.received[0]).toMatchObject({
      path: "/",
      authorization: "Bearer tk_private_token",
      body: { topic: "everyos-private-topic", title: "EveryOS deneme mesajı", priority: 3 },
    });
    // Leaving credentials out keeps them; a kind change is refused.
    const kept = await admin.request("PUT", `/api/notification-channels/${view.id}`, {
      body: {
        ...common,
        kind: "ntfy",
        name: "Renamed",
        server: ntfy.url,
      },
    });
    expect(await json(kept)).toMatchObject({ name: "Renamed", hasSecret: true });
    expect(
      (
        await admin.request("PUT", `/api/notification-channels/${view.id}`, {
          body: {
            ...common,
            kind: "webhook",
            format: "json",
            url: ntfy.url,
          },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin.post("/api/notification-channels", {
          ...common,
          kind: "ntfy",
          server: ntfy.url,
        })
      ).status,
    ).toBe(422);
    expect((await admin.delete(`/api/notification-channels/${view.id}`, { body: {} })).status).toBe(
      400,
    );
    expect(
      (
        await admin.delete(`/api/notification-channels/${view.id}`, {
          body: { confirmId: view.id },
        })
      ).status,
    ).toBe(204);
  });

  it("delivers matching system notifications only, within the burst limit", async () => {
    const { ctx, admin } = await setup();
    const hook = await fixture(204);
    const channel = await json<NotificationChannelView>(
      await admin.post("/api/notification-channels", {
        ...common,
        kind: "webhook",
        format: "json",
        url: `${hook.url}/hooks/everyos?key=private-hook-key`,
        token: "hook-bearer",
        minSeverity: "warning",
        categories: ["storage", "system"],
      }),
    );
    expect(channel.settings).toEqual({ kind: "webhook", format: "json", origin: hook.url });
    const { notifications } = ctx.services;
    notifications.raise({
      kind: "storage-low",
      severity: "warning",
      key: "/",
      params: { mount: "/", percent: 93 },
    });
    notifications.raise({
      kind: "service-failed",
      severity: "critical",
      key: "x",
      params: { unit: "x" },
    });
    notifications.publish({ kind: "app-succeeded", severity: "success", params: { app: "a" } });
    notifications.publish({
      kind: "power-scheduled",
      severity: "warning",
      key: "personal",
      params: { power: "reboot", user: "admin" },
      userId: ctx.services.users.findByUsername("admin")!.id,
    });
    await vi.waitFor(() => expect(hook.received).toHaveLength(1));
    expect(hook.received[0]).toMatchObject({
      path: "/hooks/everyos?key=private-hook-key",
      authorization: "Bearer hook-bearer",
      body: { source: "everyos", kind: "storage-low", severity: "warning", category: "storage" },
    });
    expect(String(hook.received[0]!.body.title)).toContain("Disk");
    for (let n = 0; n < 25; n++)
      notifications.publish({
        kind: "power-scheduled",
        severity: "warning",
        key: `burst-${n}`,
        params: { power: "reboot", user: "admin" },
      });
    await vi.waitFor(() => expect(hook.received).toHaveLength(20));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hook.received).toHaveLength(20);
    expect(
      (
        await json<{ channels: NotificationChannelView[] }>(
          await admin.get("/api/notification-channels"),
        )
      ).channels[0]!.lastDeliveryAt,
    ).not.toBeNull();
  });

  it("formats Discord, Slack and Telegram messages without mentions or markup", async () => {
    const telegram = await fixture();
    const { admin } = await setup({ telegram: telegram.url });
    const discord = await fixture(204);
    const slack = await fixture();
    for (const [format, target] of [
      ["discord", discord],
      ["slack", slack],
    ] as const) {
      const channel = await json<NotificationChannelView>(
        await admin.post("/api/notification-channels", {
          ...common,
          kind: "webhook",
          format,
          url: `${target.url}/webhook`,
        }),
      );
      await admin.post(`/api/notification-channels/${channel.id}/test`, {});
    }
    expect(discord.received[0]!.body).toMatchObject({
      username: "EveryOS",
      allowed_mentions: { parse: [] },
    });
    expect(String(slack.received[0]!.body.text)).toContain("EveryOS deneme mesajı");
    const bot = await json<NotificationChannelView>(
      await admin.post("/api/notification-channels", {
        ...common,
        kind: "telegram",
        language: "en",
        chatId: "-1001234567890",
        botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      }),
    );
    expect(bot.settings).toEqual({ kind: "telegram", chatId: "-1001234567890" });
    await admin.post(`/api/notification-channels/${bot.id}/test`, {});
    expect(telegram.received[0]).toMatchObject({
      path: "/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ012345/sendMessage",
      body: { chat_id: "-1001234567890", disable_web_page_preview: true },
    });
    expect(telegram.received[0]!.body).not.toHaveProperty("parse_mode");
    expect(String(telegram.received[0]!.body.text)).toContain("EveryOS test message");
  });

  it("sends e-mail only over TLS when signing in and reports failures without secrets", async () => {
    const { admin, mails } = await setup();
    const email = {
      ...common,
      kind: "email",
      host: "127.0.0.1",
      port: 587,
      security: "starttls",
      username: "everyos@example.com",
      password: "smtp-private-password",
      from: "everyos@example.com",
      to: ["owner@example.com", "owner@example.com"],
    };
    expect(
      (await admin.post("/api/notification-channels", { ...email, security: "none" })).status,
    ).toBe(422);
    const channel = await json<NotificationChannelView>(
      await admin.post("/api/notification-channels", email),
    );
    expect(JSON.stringify(channel)).not.toContain("smtp-private-password");
    await admin.post(`/api/notification-channels/${channel.id}/test`, {});
    expect(mails[0]!.options).toMatchObject({
      host: "127.0.0.1",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "everyos@example.com", pass: "smtp-private-password" },
      tls: { minVersion: "TLSv1.2" },
    });
    expect(mails[0]!.mail).toMatchObject({
      to: ["owner@example.com"],
      subject: "ℹ️ EveryOS deneme mesajı",
    });
    const failing = await fixture(500);
    const hook = await json<NotificationChannelView>(
      await admin.post("/api/notification-channels", {
        ...common,
        kind: "webhook",
        format: "json",
        url: failing.url,
      }),
    );
    const result = await admin.post(`/api/notification-channels/${hook.id}/test`, {});
    expect(result.status).toBe(502);
    expect(await result.text()).toContain("http-status-500");
    expect(
      (
        await json<{ channels: NotificationChannelView[] }>(
          await admin.get("/api/notification-channels"),
        )
      ).channels.find((entry) => entry.id === hook.id)?.lastError,
    ).toBe("http-status-500");
  });

  it("renders the notification center's texts on the server", () => {
    expect(
      renderNotification(
        { kind: "power-scheduled", params: { power: "reboot", user: "ada" } },
        "tr",
      ),
    ).toEqual({
      title: "Sunucu yeniden başlatılıyor",
      body: "ada bu işlemi başlattı. Uygulamalar ve konteynerler bir süre erişilemez olacak.",
    });
    expect(
      renderNotification(
        { kind: "power-scheduled", params: { power: "shutdown", user: "ada" } },
        "en",
      ).title,
    ).toBe("The server is shutting down");
  });
});
