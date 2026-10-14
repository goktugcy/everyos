import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import {
  CSRF_HEADER,
  type AiAgentKind,
  type AiConversation,
  type AiAgentView,
  type AppJobView,
  type LocalModelsView,
} from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

async function openAssistantSettings(page: Page) {
  await page.getByTestId("ai-agent-menubar").click();
  await page.getByRole("button", { name: "AI Asistanları", exact: true }).click();
  const settings = page.locator('[data-app-id="everyos.settings"]');
  await expect(settings.getByTestId("settings-agents")).toBeVisible();
  return settings;
}
async function removeApp(page: Page, headers: Record<string, string>, appId: string) {
  const response = await page.request.post(`/api/apps/${appId}/actions`, {
    headers,
    data: { action: "remove", confirmId: appId },
  });
  if (response.status() !== 202) return;
  const job = (await response.json()) as AppJobView;
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/apps/jobs/${job.id}`)).json()) as AppJobView).stage,
    )
    .toMatch(/succeeded|failed/);
}

test("the wizard connects a local model and both agents, chat works and cancellation recovers", async ({
  page,
}) => {
  const requests: Array<{
    kind: AiAgentKind;
    model: string;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  let cancelled = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const kind = request.url?.startsWith("/openclaw/")
      ? "openclaw"
      : request.url?.startsWith("/ollama/")
        ? "local"
        : "hermes";
    // Local model servers usually have no key; agent gateways always do.
    if (kind !== "local" && request.headers.authorization !== "Bearer e2e-agent-key") {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.url?.endsWith("/v1/models")) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id:
                kind === "hermes"
                  ? "hermes-agent"
                  : kind === "openclaw"
                    ? "openclaw/default"
                    : "qwen3:0.6b",
            },
          ],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(part as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString()) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    requests.push({ kind, model: input.model, messages: input.messages });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (input.messages.at(-1)?.content === "Model hatası") {
      // Hermes's failed turn: fallback text, then finish_reason "error" with its own reason.
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "⚠️ Hata" } }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "error" }],
          error: {
            message: "HTTP 400: The 'gpt-5.5' model is not supported.",
            type: "agent_error",
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
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
    const settings = await openAssistantSettings(page);
    await page.screenshot({
      path: test.info().outputPath("assistants-overview.png"),
      animations: "disabled",
    });
    // A local model server at an address, no key.
    await settings.getByTestId("assistant-add").click();
    const wizard = page.getByTestId("assistant-wizard");
    await expect(wizard).toHaveAttribute("data-step", "type");
    await page.screenshot({
      path: test.info().outputPath("assistant-wizard.png"),
      animations: "disabled",
    });
    await wizard.getByTestId("wizard-kind-local").click();
    await wizard.getByTestId("wizard-next").click();
    await page.screenshot({
      path: test.info().outputPath("wizard-local-source.png"),
      animations: "disabled",
    });
    await wizard.getByTestId("local-source-manual").click();
    await expect(wizard.getByTestId("wizard-next")).toBeEnabled();
    await wizard
      .getByLabel("Sunucu adresi", { exact: true })
      .fill(`http://127.0.0.1:${port}/ollama`);
    await wizard.getByTestId("wizard-next").click();
    await expect(wizard.getByTestId("wizard-next")).toBeDisabled();
    await wizard.getByLabel("Model", { exact: true }).fill("qwen3:0.6b");
    await wizard.getByTestId("wizard-next").click();
    await expect(wizard).toContainText("qwen3:0.6b");
    await wizard.getByTestId("wizard-finish").click();
    await expect(wizard.getByRole("status")).toContainText("Hazır");
    await wizard.getByRole("button", { name: "Kapat", exact: true }).click();
    // Existing agents, through the same wizard.
    for (const kind of ["hermes", "openclaw"] as const) {
      await settings.getByTestId(`assistant-setup-${kind}`).click();
      await expect(wizard).toHaveAttribute("data-step", "source");
      await wizard.getByTestId("agent-mode-external").click();
      await wizard
        .getByLabel("Asistanın adresi", { exact: true })
        .fill(`http://127.0.0.1:${port}/${kind}`);
      await wizard.getByLabel("Asistanın erişim anahtarı", { exact: true }).fill("e2e-agent-key");
      await wizard.getByTestId("wizard-next").click();
      await expect(wizard.getByLabel("Asistanın model adı", { exact: true })).toHaveValue(
        kind === "hermes" ? "hermes-agent" : "openclaw/default",
      );
      await wizard.getByTestId("wizard-next").click();
      await wizard.getByTestId("wizard-finish").click();
      await expect(wizard.getByRole("status")).toContainText("Hazır");
      await wizard.getByRole("button", { name: "Kapat", exact: true }).click();
      expect(await (await page.request.get(`/api/ai-agents/${kind}`)).text()).not.toContain(
        "e2e-agent-key",
      );
    }
    for (const kind of ["local", "hermes", "openclaw"] as const)
      await expect(settings.getByTestId(`assistant-card-${kind}`)).toContainText("Hazır");
    await settings.getByRole("button", { name: "Kapat", exact: true }).click();
    await page.getByTestId("ai-agent-menubar").click();
    const panel = page.getByRole("dialog", { name: "AI asistanları", exact: true });
    await expect(panel).toContainText("Yerel model");
    await expect(panel).toContainText("Hermes Agent");
    await expect(panel).toContainText("OpenClaw");
    await panel.getByRole("button", { name: "Sohbet et", exact: true }).first().click();
    const app = page.locator('[data-app-id="everyos.agents"]');
    for (const kind of ["local", "hermes", "openclaw"] as const) {
      await app.getByLabel("Asistan", { exact: true }).selectOption(kind);
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
    // The local chat asked the chosen model directly.
    expect(requests.find((entry) => entry.kind === "local")?.model).toBe("qwen3:0.6b");
    await app.getByLabel("Asistan", { exact: true }).selectOption("hermes");
    await app.getByRole("button", { name: "hermes sorusu", exact: true }).click();
    await app.getByLabel("Mesaj", { exact: true }).fill("Uzun görev");
    await app.getByRole("button", { name: "Gönder", exact: true }).click();
    await expect(app.getByTestId("ai-chat-messages")).toContainText("Devam eden yanıt");
    await app.getByRole("button", { name: "Yanıtı durdur", exact: true }).click();
    await expect.poll(() => cancelled).toBe(true);
    await expect(app.getByLabel("Mesaj", { exact: true })).toBeEnabled();
    await app.getByLabel("Mesaj", { exact: true }).fill("İkinci soru");
    await app.getByRole("button", { name: "Gönder", exact: true }).click();
    await expect.poll(() => requests.length).toBe(5);
    expect(requests.at(-1)?.messages).toHaveLength(3);
    await expect(app.getByRole("button", { name: "Gönder", exact: true })).toBeVisible();
    // An agent-reported failure shows its reason, and the new chat still appears in the list.
    await app.getByRole("button", { name: "Yeni sohbet", exact: true }).first().click();
    await app.getByLabel("Mesaj", { exact: true }).fill("Model hatası");
    await app.getByRole("button", { name: "Gönder", exact: true }).click();
    await expect(app).toContainText(
      "Hermes Agent yanıtı tamamlayamadı: HTTP 400: The 'gpt-5.5' model is not supported.",
    );
    await expect(app.getByLabel("Mesaj", { exact: true })).toHaveValue("Model hatası");
    const failed = (
      (await (await page.request.get("/api/ai-agents/hermes/conversations")).json()) as {
        conversations: AiConversation[];
      }
    ).conversations.find((entry) => entry.title === "")!;
    threads.push({ kind: "hermes", id: failed.id });
    await expect(app.getByRole("button", { name: "Yeni sohbet", exact: true })).toHaveCount(2);
    await app.getByLabel("Mesaj", { exact: true }).fill("");
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

test("a managed agent installs only after confirmation, shows real job state and labels simulator state", async ({
  page,
}) => {
  const session = await signIn(page),
    headers = { [CSRF_HEADER]: session.csrfToken };
  const settings = await openAssistantSettings(page);
  const before = (await (await page.request.get("/api/ai-agents/hermes")).json()) as AiAgentView;
  if (before.configured) await settings.getByTestId("assistant-edit-hermes").click();
  else await settings.getByTestId("assistant-setup-hermes").click();
  const wizard = page.getByTestId("assistant-wizard");
  const editor = page.getByTestId("ai-settings-hermes");
  const form = before.configured ? editor : wizard;
  await form.getByTestId("agent-mode-managed").click();
  if (!before.configured) await wizard.getByTestId("wizard-next").click();
  await form.getByTestId("provider-custom").click();
  await form
    .getByLabel("Model sunucusunun adresi", { exact: true })
    .fill("http://192.0.2.1:8000/v1");
  await form.getByLabel("Model", { exact: true }).fill("fixture-model");
  if (!before.configured) {
    await wizard.getByTestId("wizard-next").click();
    await expect(wizard).toContainText("Resmi paket indirilir");
    await wizard.getByTestId("wizard-finish").click();
  } else {
    await editor.getByTestId("ai-settings-save").click();
    const confirm = page.getByRole("dialog", { name: /Hermes Agent · Kaydet ve kur/ });
    await confirm.getByRole("button", { name: "Vazgeç", exact: true }).click();
    expect(
      ((await (await page.request.get("/api/ai-agents/hermes")).json()) as AiAgentView).app,
    ).toBeNull();
    await editor.getByTestId("ai-settings-save").click();
    await confirm.getByRole("button", { name: "Onayla", exact: true }).click();
  }
  await expect(form).toContainText("Tamamlandı");
  await expect(form).toContainText("Durum doğrulanamadı");
  const view = (await (await page.request.get("/api/ai-agents/hermes")).json()) as AiAgentView;
  expect(view.app?.state).toBe("running");
  expect(view.source).toBe("simulated");
  const appId = view.app!.id;
  try {
    // The wizard closes into the overview; the editor is already open.
    if (!before.configured) {
      await wizard.getByRole("button", { name: "Kapat", exact: true }).click();
      await settings.getByTestId("assistant-edit-hermes").click();
    }
    await expect(editor.getByTestId("simulated-badge")).toBeVisible();
    await editor.getByLabel("Model", { exact: true }).fill("fixture-model-next");
    await editor.getByRole("button", { name: "Kaydet ve yeniden başlat", exact: true }).click();
    await expect
      .poll(
        async () =>
          ((await (await page.request.get("/api/ai-agents/hermes")).json()) as AiAgentView).job
            ?.stage,
      )
      .toBe("succeeded");
    await expect(
      editor.getByRole("button", { name: "Kaydet ve yeniden başlat", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath("agent-settings.png"),
      animations: "disabled",
    });
  } finally {
    await removeApp(page, headers, appId);
  }
});

test("the EveryOS Ollama installs once for the system and offers only the GPUs Docker can use", async ({
  page,
}) => {
  const session = await signIn(page),
    headers = { [CSRF_HEADER]: session.csrfToken };
  const settings = await openAssistantSettings(page);
  const panel = settings.getByTestId("everyos-ollama");
  await expect(panel).toContainText("Kurulu değil");
  await panel.getByTestId("ollama-install").click();
  const dialog = page.getByRole("dialog", { name: "Ollama'yı kur", exact: true });
  await expect(dialog.getByTestId("ollama-acceleration-cpu")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // The simulator reports no GPU runtime: neither GPU can be chosen.
  await expect(dialog.getByTestId("ollama-acceleration-nvidia")).toBeDisabled();
  await expect(dialog.getByTestId("ollama-acceleration-amd")).toBeDisabled();
  await dialog.getByTestId("ollama-setup-confirm").click();
  await expect(panel).toContainText("Tamamlandı");
  await expect(panel.getByTestId("simulated-badge")).toBeVisible();
  const local = (await (
    await page.request.get("/api/ai-agents/local-models")
  ).json()) as LocalModelsView;
  expect(local.ollama).toMatchObject({ acceleration: "cpu", app: { state: "running" } });
  await page.screenshot({
    path: test.info().outputPath("local-models.png"),
    animations: "disabled",
  });
  await removeApp(page, headers, local.ollama.app!.id);
});
