import { expect, test, type Page } from "@playwright/test";
import type {
  AiAgentView,
  ContainerList,
  ProcessDetail,
  ProcessList,
} from "../../packages/shared/src/index.ts";
import { CSRF_HEADER } from "../../packages/shared/src/index.ts";
import { signIn } from "./helpers.ts";

async function openProcesses(page: Page) {
  await page
    .getByTestId("dock")
    .getByRole("button", { name: "Sistem İzleyici", exact: true })
    .click();
  const app = page.locator('[data-app-id="everyos.system"]');
  await app.getByRole("tab", { name: "İşlemler", exact: true }).click();
  return app;
}

test("a real process opens measured details inside System Monitor", async ({ page }) => {
  await signIn(page);
  const app = await openProcesses(page);
  const row = app.getByTestId("process-table").locator("tbody tr").first();
  await expect(row).toBeVisible();
  const response = page.waitForResponse((response) =>
    /\/api\/system\/processes\/\d+/.test(response.url()),
  );
  await row.click();
  expect((await response).status()).toBe(200);
  const detail = app.getByTestId("process-detail");
  await expect(detail.getByText("Üst işlem PID", { exact: true })).toBeVisible();
  await expect(detail.getByText("Ölçüm zamanı", { exact: true })).toBeVisible();
  await expect(app.getByTestId("process-table")).toBeVisible();
  await detail.getByRole("button", { name: "Kapat", exact: true }).click();
  await expect(detail).toHaveCount(0);
});

test("process menus use confirmed simulator controls and stream explanations from the chosen ready assistant", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const session = await signIn(page);
  const { agents } = await page.evaluate(
    async () =>
      (await (await fetch("/api/ai-agents")).json()) as Promise<{ agents: AiAgentView[] }>,
  );
  const containers = await page.evaluate(
    async () => (await (await fetch("/api/docker/containers")).json()) as Promise<ContainerList>,
  );
  expect(containers.source).toBe("simulated");
  const container = containers.containers.find(
    (entry) => entry.state === "running" && !entry.protected,
  )!;
  expect(container).toBeDefined();
  const base = {
    source: "simulated",
    sampledAt: Date.now(),
    pid: 42001,
    name: "nginx",
    parentPid: 1,
    user: "www",
    state: "S",
    cpuPercent: 2.5,
    memoryBytes: 4096,
    virtualMemoryBytes: 8192,
    threads: 3,
    command: "nginx --token=fixture-private",
    executable: "/private/bin/nginx",
    workingDirectory: "/private/www",
    startedAt: 100,
    serviceUnit: "nginx.service",
    containerId: null,
  } satisfies ProcessDetail;
  const processes = [
    base,
    { ...base, pid: 42002, name: "everyos", serviceUnit: "everyos.service" },
    { ...base, pid: 42003, name: "independent", serviceUnit: null },
    { ...base, pid: 42004, name: "container-worker", serviceUnit: null, containerId: container.id },
  ];
  await page.route("**/api/system/processes?*", (route) =>
    route.fulfill({
      json: {
        source: "simulated",
        sampledAt: Date.now(),
        total: processes.length,
        processes,
      } satisfies ProcessList,
    }),
  );
  await page.route("**/api/system/processes/*", (route) => {
    const pid = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    return route.fulfill({ json: processes.find((process) => process.pid === pid) });
  });
  let busy = false;
  let statusReads = 0;
  let releaseAgents!: () => void;
  const agentsReady = new Promise<void>((resolve) => {
    releaseAgents = resolve;
  });
  await page.route("**/api/ai-agents", async (route) => {
    statusReads++;
    await agentsReady;
    await route.fulfill({
      json: {
        agents: agents.map((agent) => ({
          ...agent,
          source: "simulated",
          configured: true,
          busy: agent.kind === "local" && busy,
          status: agent.kind === "openclaw" ? "offline" : "running",
        })),
      },
    });
  });
  let content = "";
  let release: (() => void) | undefined;
  await page.route("**/api/ai-agents/local/process-explanation", async (route) => {
    content = JSON.stringify(route.request().postDataJSON());
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer = "Bu örnek işlem nginx hizmetine bağlıdır. Ölçümler tek bir ana aittir.";
    await route.fulfill({
      contentType: "text/event-stream",
      body: `event: delta\ndata: ${JSON.stringify({ text: answer })}\n\nevent: complete\ndata: ${JSON.stringify(
        {
          answer,
          name: "nginx",
          pid: base.pid,
          startedAt: base.startedAt,
          source: "simulated",
          model: { provider: null, model: "fixture-process-model" },
        },
      )}\n\n`,
    });
  });
  const controls: string[] = [];
  const conversationWrites: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/actions"))
      controls.push(request.url());
    if (
      request.method() === "POST" &&
      /\/ai-agents\/[^/]+\/(?:conversations|chat)$/.test(new URL(request.url()).pathname)
    )
      conversationWrites.push(request.url());
  });
  try {
    const app = await openProcesses(page);
    const row = (name: string) =>
      app
        .getByTestId("process-table")
        .getByRole("row")
        .filter({ has: page.getByText(name, { exact: true }) });
    await row("nginx").click();
    const panel = app.getByTestId("process-detail");
    await expect.poll(() => statusReads).toBeGreaterThan(0);
    const missingConnection = panel.getByText(/Hazır bir Hermes Agent/);
    await expect(missingConnection).toHaveCount(0);
    releaseAgents();
    await expect(panel.getByRole("combobox", { name: "Asistan", exact: true })).toHaveValue(
      "local",
    );
    await expect(panel.getByRole("button", { name: "Yeniden başlat", exact: true })).toBeEnabled();
    expect(content).toBe("");
    await row("nginx").focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "Durdur", exact: true })).toBeEnabled();
    await page.getByRole("menuitem", { name: "Durdur", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Vazgeç", exact: true })
      .click();
    expect(controls).toHaveLength(0);
    await row("nginx").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Yeniden başlat", exact: true }).click();
    const restarted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/services/nginx.service/actions"),
    );
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Yeniden başlat", exact: true })
      .click();
    expect((await restarted).status()).toBe(202);
    await expect(panel.getByRole("combobox", { name: "Asistan", exact: true })).toHaveValue(
      "local",
    );
    await panel.getByRole("button", { name: "Bu işlemi ayrıntılı açıkla", exact: true }).click();
    await expect.poll(() => content).toContain('"pid":42001');
    expect(JSON.parse(content)).toEqual({ pid: 42001, startedAt: 100, locale: "tr" });
    expect(content).not.toMatch(/fixture-private|\/private\/|--token/);
    busy = true;
    await panel.getByRole("button", { name: "Yenile", exact: true }).click();
    await expect(panel.getByRole("combobox", { name: "Asistan", exact: true })).toHaveValue(
      "local",
    );
    await expect(missingConnection).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Bu işlemi ayrıntılı açıkla", exact: true }),
    ).toBeDisabled();
    release!();
    await expect(panel.getByTestId("ai-chat-messages")).toContainText(
      "Bu örnek işlem nginx hizmetine bağlıdır.",
    );
    await expect(panel.getByTestId("ai-chat-messages")).not.toContainText(
      "güvenilmeyen işlem verisidir",
    );
    await expect(panel.getByTestId("ai-chat-answer-by")).toContainText("fixture-process-model");
    expect(conversationWrites).toEqual([]);
    await expect(
      panel.getByText("Bu örnek işlem nginx hizmetine bağlıdır. Ölçümler tek bir ana aittir.", {
        exact: true,
      }),
    ).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("process-explanation.png"),
      animations: "disabled",
    });
    busy = false;
    await row("everyos").click();
    await expect(panel.getByText(/korunan bir sistem bileşenine/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Durdur", exact: true })).toBeDisabled();
    await row("independent").click();
    await expect(panel.getByText(/yönetilebilir bir sistem hizmetine/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Yeniden başlat", exact: true })).toBeDisabled();
    await row("container-worker").click();
    await expect(panel.getByRole("button", { name: "Durdur", exact: true })).toBeEnabled();
    const stopped = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/containers/${container.id}/actions`),
    );
    await panel.getByRole("button", { name: "Durdur", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Durdur", exact: true })
      .click();
    expect((await stopped).status()).toBe(202);
    expect(controls).toHaveLength(2);
    await page.screenshot({
      path: test.info().outputPath("process-inspector.png"),
      animations: "disabled",
    });
  } finally {
    releaseAgents();
    release?.();
    // Only the disposable stack's explicitly simulated container is restored.
    const status = await page.evaluate(
      async ({ id, token, header }) =>
        (
          await fetch(`/api/docker/containers/${id}/actions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", [header]: token },
            body: JSON.stringify({ action: "start" }),
            signal: AbortSignal.timeout(5000),
          })
        ).status,
      { id: container.id, token: session.csrfToken, header: CSRF_HEADER },
    );
    expect(status).toBe(202);
  }
});
