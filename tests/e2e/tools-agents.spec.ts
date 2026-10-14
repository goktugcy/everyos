import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import {
  CSRF_HEADER,
  type AiAgentKind,
  type AiConversation,
  type AiAgentView,
  type AppJobView,
} from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

test("agent settings connect both real HTTP gateways, menu status opens chat, and cancellation recovers", async ({
  page,
}) => {
  const requests: Array<{ kind: AiAgentKind; messages: Array<{ role: string; content: string }> }> =
    [];
  let cancelled = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const kind = request.url?.startsWith("/openclaw/") ? "openclaw" : "hermes";
    if (request.headers.authorization !== "Bearer e2e-agent-key") {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.url?.endsWith("/v1/models")) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ data: [{ id: kind === "hermes" ? "hermes-agent" : "openclaw/default" }] }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(part as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString()) as {
      messages: Array<{ role: string; content: string }>;
    };
    requests.push({ kind, messages: input.messages });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const text =
      input.messages.at(-1)?.content === "Uzun görev"
        ? "Devam eden yanıt · agent çalışıyor."
        : `${kind} yanıtı 🌍 <script>literal</script>`;
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    if (input.messages.at(-1)?.content === "Uzun görev") {
      response.on("close", () => {
        cancelled = true;
      });
      return;
    }
    response.end("data: [DONE]\n\n");
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const session = await signIn(page),
    headers = { [CSRF_HEADER]: session.csrfToken };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const threads: Array<{ kind: AiAgentKind; id: string }> = [];
  try {
    await page.getByTestId("ai-agent-menubar").click();
    await page.getByRole("button", { name: "Agent Ayarları", exact: true }).click();
    const settings = page.locator('[data-app-id="everyos.settings"]');
    await expect(settings.getByTestId("settings-agents")).toBeVisible();
    for (const kind of ["hermes", "openclaw"] as const) {
      await settings.getByLabel("Agent", { exact: true }).selectOption(kind);
      const form = settings.getByTestId(`ai-settings-${kind}`);
      await form.getByLabel("Kurulum türü", { exact: true }).selectOption("external");
      await form
        .getByLabel("Agent API adresi", { exact: true })
        .fill(`http://127.0.0.1:${port}/${kind}`);
      await form
        .getByLabel("Agent API anahtarı / Gateway token", { exact: true })
        .fill("e2e-agent-key");
      await form.getByRole("button", { name: "Kaydet", exact: true }).click();
      await expect(form).toContainText("Bağlı · sohbet hazır");
      expect(await (await page.request.get(`/api/ai-agents/${kind}`)).text()).not.toContain(
        "e2e-agent-key",
      );
    }
    await settings.getByRole("button", { name: "Kapat", exact: true }).click();
    await page.getByTestId("ai-agent-menubar").click();
    const panel = page.getByRole("dialog", { name: "AI agent'ları", exact: true });
    await expect(panel).toContainText("Hermes Agent");
    await expect(panel).toContainText("OpenClaw");
    await panel.getByRole("button", { name: "Sohbeti aç", exact: true }).first().click();
    const app = page.locator('[data-app-id="everyos.agents"]');
    for (const kind of ["hermes", "openclaw"] as const) {
      await app.getByLabel("Agent", { exact: true }).selectOption(kind);
      await app.getByLabel("Mesaj", { exact: true }).fill(`${kind} sorusu`);
      await app.getByRole("button", { name: "Gönder", exact: true }).click();
      await expect(app.getByTestId("ai-chat-messages")).toContainText(
        `${kind} yanıtı 🌍 <script>literal</script>`,
      );
      await expect(app.getByRole("button", { name: "Gönder", exact: true })).toBeVisible();
      expect(await app.locator("script").count()).toBe(0);
      const history = (await (
        await page.request.get(`/api/ai-agents/${kind}/conversations`)
      ).json()) as { conversations: AiConversation[] };
      const thread = history.conversations.find((entry) => entry.title === `${kind} sorusu`)!;
      threads.push({ kind, id: thread.id });
      expect(
        (
          (await (
            await page.request.get(`/api/ai-agents/${kind}/conversations/${thread.id}`)
          ).json()) as AiConversation
        ).messages,
      ).toHaveLength(2);
    }
    await app.getByLabel("Agent", { exact: true }).selectOption("hermes");
    await app.getByRole("button", { name: "hermes sorusu", exact: true }).click();
    await app.getByLabel("Mesaj", { exact: true }).fill("Uzun görev");
    await app.getByRole("button", { name: "Gönder", exact: true }).click();
    await expect(app.getByTestId("ai-chat-messages")).toContainText("Devam eden yanıt");
    await app.getByRole("button", { name: "Yanıtı durdur", exact: true }).click();
    await expect.poll(() => cancelled).toBe(true);
    await expect(app.getByLabel("Mesaj", { exact: true })).toBeEnabled();
    await app.getByLabel("Mesaj", { exact: true }).fill("İkinci soru");
    await app.getByRole("button", { name: "Gönder", exact: true }).click();
    await expect.poll(() => requests.length).toBe(4);
    expect(requests.at(-1)?.messages).toHaveLength(3);
    await expect(app.getByRole("button", { name: "Gönder", exact: true })).toBeVisible();
    await page.reload();
    const restored = page.locator('[data-app-id="everyos.agents"]');
    await restored.getByRole("button", { name: "hermes sorusu", exact: true }).click();
    await expect(restored.getByTestId("ai-chat-messages")).toContainText("İkinci soru");
    await page.screenshot({
      path: test.info().outputPath("agent-chat.png"),
      animations: "disabled",
    });
    await restored.getByRole("button", { name: "Sohbeti sil", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Sohbeti sil", exact: true })
      .getByRole("button", { name: "Sil", exact: true })
      .click();
    await expect(restored.getByRole("button", { name: "hermes sorusu", exact: true })).toHaveCount(
      0,
    );
    expect(errors).toEqual([]);
  } finally {
    for (const thread of threads)
      await page.request.delete(`/api/ai-agents/${thread.kind}/conversations/${thread.id}`, {
        headers,
        data: { confirmId: thread.id },
      });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("managed agent install requires confirmation, shows real job state and labels simulator state", async ({
  page,
}) => {
  const session = await signIn(page),
    headers = { [CSRF_HEADER]: session.csrfToken };
  await page.getByTestId("ai-agent-menubar").click();
  await page.getByRole("button", { name: "Agent Ayarları", exact: true }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await settings.getByLabel("Agent", { exact: true }).selectOption("hermes");
  const form = settings.getByTestId("ai-settings-hermes");
  await form.getByLabel("Kurulum türü", { exact: true }).selectOption("managed");
  await form.getByLabel("Model sağlayıcısı", { exact: true }).selectOption("custom");
  await form.getByLabel("Model kimliği", { exact: true }).fill("fixture-model");
  await form.getByLabel("Model API adresi", { exact: true }).fill("http://192.0.2.1:8000/v1");
  await form.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect(
    form.getByRole("button", { name: "Agent'ı indir ve kur", exact: true }),
  ).toBeEnabled();
  await form.getByRole("button", { name: "Agent'ı indir ve kur", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: /Hermes Agent.*Agent'ı indir ve kur/ });
  await confirm.getByRole("button", { name: "Vazgeç", exact: true }).click();
  expect(
    ((await (await page.request.get("/api/ai-agents/hermes")).json()) as AiAgentView).app,
  ).toBeNull();
  await form.getByRole("button", { name: "Agent'ı indir ve kur", exact: true }).click();
  await confirm.getByRole("button", { name: "Onayla", exact: true }).click();
  await expect(form).toContainText("Tamamlandı");
  await expect(form.getByTestId("simulated-badge")).toBeVisible();
  await expect(form).toContainText("Durum doğrulanamadı");
  const view = (await (await page.request.get("/api/ai-agents/hermes")).json()) as AiAgentView;
  expect(view.app?.state).toBe("running");
  expect(view.source).toBe("simulated");
  const appId = view.app!.id;
  try {
    await form.getByLabel("Model kimliği", { exact: true }).fill("fixture-model-next");
    await form.getByRole("button", { name: "Kaydet ve yeniden başlat", exact: true }).click();
    await expect
      .poll(
        async () =>
          ((await (await page.request.get("/api/ai-agents/hermes")).json()) as AiAgentView).job
            ?.stage,
      )
      .toBe("succeeded");
    await expect(
      form.getByRole("button", { name: "Kaydet ve yeniden başlat", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath("agent-settings.png"),
      animations: "disabled",
    });
  } finally {
    const response = await page.request.post(`/api/apps/${appId}/actions`, {
      headers,
      data: { action: "remove", confirmId: appId },
    });
    if (response.status() === 202) {
      const job = (await response.json()) as AppJobView;
      await expect
        .poll(
          async () =>
            ((await (await page.request.get(`/api/apps/jobs/${job.id}`)).json()) as AppJobView)
              .stage,
        )
        .toMatch(/succeeded|failed/);
    }
  }
});
