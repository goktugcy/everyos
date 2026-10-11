/** Run only in a disposable Linux runtime against its explicitly identified Docker daemon. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  chownSync,
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { AgentClient, type Actor } from "../packages/agent-protocol/src/index.ts";
import type {
  AppJobView,
  CatalogAppView,
  CatalogView,
  InstalledAppView,
  SessionInfo,
} from "../packages/shared/src/index.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 0);
assert.equal(process.env.EVERYOS_DISPOSABLE_ACCEPTANCE, "1", "Disposable-host opt-in required");
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 180_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
assert.ok(process.env.EVERYOS_ACCEPTANCE_DOCKER_ID);
assert.equal(docker("info", "--format", "{{.ID}}"), process.env.EVERYOS_ACCEPTANCE_DOCKER_ID);
assert.equal(docker("ps", "-aq"), "", "Acceptance daemon must start empty");
const dist = process.env.EVERYOS_ACCEPTANCE_DIST ?? "/opt/everyos-share/dist";
const state = mkdtempSync(`${process.env.EVERYOS_ACCEPTANCE_STATE_ROOT ?? "/tmp"}/everyos-phase5-`);
chmodSync(state, 0o755);
const data = join(state, "api"),
  run = join(state, "run"),
  secrets = join(state, "secrets");
for (const path of [data, run, secrets]) mkdirSync(path, { mode: 0o750 });
chownSync(data, 1000, 1000);
const socket = join(run, "agent.sock"),
  key = join(secrets, "agent.key");
const agentConfig = join(state, "agent.yaml");
writeFileSync(
  agentConfig,
  JSON.stringify({
    socketGroup: 1000,
    socketPath: socket,
    agentKeyFile: key,
    dockerSocket: "/var/run/docker.sock",
    internetCheckTargets: [],
    protectedContainers: ["phase5-foreign"],
  }),
  { mode: 0o600 },
);
const apiConfig = join(state, "api.yaml");
writeFileSync(
  apiConfig,
  JSON.stringify({
    server: { host: "127.0.0.1", port: 17470 },
    paths: { dataDir: data, agentSocket: socket, agentKeyFile: key, webDir: join(dist, "web") },
    security: { cookieSecure: "never" },
    logging: { level: "warn", format: "json" },
  }),
);
const children: ChildProcess[] = [];
const launch = (kind: "api" | "agent") => {
  const fd = openSync(join(state, `${kind}.log`), "a", 0o600);
  const child = spawn(
    process.execPath,
    [join(dist, kind === "api" ? "api/server.mjs" : "agent/agent.mjs")],
    {
      env: {
        ...process.env,
        EVERYOS_ENV: "production",
        EVERYOS_CONFIG: apiConfig,
        EVERYOS_AGENT_CONFIG: agentConfig,
      },
      ...(kind === "api" ? { uid: 1000, gid: 1000 } : {}),
      stdio: ["ignore", fd, fd],
    },
  );
  closeSync(fd);
  children.push(child);
  return child;
};
async function until<T>(
  get: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeout = 30_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await get();
    if (accept(value)) return value;
    await delay(200);
  }
  throw new Error("Acceptance condition timed out");
}
const checks: string[] = [];
const pass = (name: string) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
let apiProcess: ChildProcess, agentProcess: ChildProcess;
let client: AgentClient | null = null;
let cookie = "",
  csrf = "";
const base = "http://127.0.0.1:17470";
async function request<T>(
  path: string,
  body?: unknown,
  expected = body === undefined ? 200 : 202,
): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "x-everyos-csrf": csrf,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== expected) {
    const failure = (await response.json()) as { error: { code: string; details?: unknown } };
    throw new Error(
      `${path}: HTTP ${response.status}, ${failure.error.code}, ${JSON.stringify(failure.error.details)}`,
    );
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  return (await response.json()) as T;
}
const apps = async () => (await request<{ apps: InstalledAppView[] }>("/apps")).apps;
const finished = (id: string) =>
  until(
    () => request<AppJobView>(`/apps/jobs/${id}`),
    (job) => job.stage === "succeeded" || job.stage === "failed",
    170_000,
  );
const fixtureImage = "everyos-phase5-fixture:current";
const template = (mode: string) =>
  `services:\n  app:\n    image: ${fixtureImage}\n    pull_policy: never\n    user: '1000:1000'\n    environment:\n      ACCEPTANCE_SECRET: \${APP_SECRET}\n    ports: ['18765:8080']\n    volumes: ['\${APP_DATA_DIR}/www:/data']\n    command: ['sh', '-c', 'test "$(cat /image-version)" = good || exit 1; ${mode === "slow" ? "sleep 8; " : ""}test -f /data/index.html || echo persisted-data > /data/index.html; exec httpd -f -p 8080 -h /data']\n    healthcheck:\n      test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080']\n      interval: 1s\n${mode === "slow" ? "      start_period: 15s\n" : ""}      timeout: 1s\n      retries: 2\nx-casaos:\n  title: Acceptance ${mode}\n  architectures: [amd64, arm64]\n`;
// Escape shell dollars as Compose literals; only APP_SECRET and APP_DATA_DIR interpolate.
const catalog = createServer((req, res) => {
  let content = template(req.url?.includes("slow") ? "slow" : "normal").replaceAll("$(", "$$(");
  if (req.url?.includes("inline")) {
    content = content
      .replace(
        "    volumes: ['${APP_DATA_DIR}/www:/data']",
        "    volumes:\n      - type: bind\n        source: ${APP_DATA_DIR}/www\n        target: /data\n      - type: bind\n        source: ./config.txt\n        target: /config.txt\n        content: 'token=${APP_SECRET}'",
      )
      .replace(
        "test -f /data/index.html",
        "test -s /config.txt || exit 2; test -f /data/index.html",
      );
    content = JSON.stringify({
      inline: {
        slogan: "Original RAM-only config fixture",
        compose: Buffer.from(content).toString("base64"),
      },
    });
  }
  res.end(content);
});
catalog.listen(17471, "127.0.0.1");
await once(catalog, "listening");
const secret = `acceptance-${randomUUID()}-$literal`;
let actor: Actor;
try {
  docker("pull", "busybox:1.37");
  const contextDir = join(state, "image");
  mkdirSync(contextDir);
  for (const version of ["good", "bad"]) {
    writeFileSync(join(contextDir, "version"), version);
    writeFileSync(
      join(contextDir, "Dockerfile"),
      "FROM busybox:1.37\nCOPY version /image-version\n",
    );
    docker("build", "--quiet", "--tag", `everyos-phase5-fixture:${version}`, contextDir);
  }
  docker("tag", "everyos-phase5-fixture:good", fixtureImage);
  agentProcess = launch("agent");
  apiProcess = launch("api");
  assert.ok(apiProcess.pid);
  await until(
    () =>
      fetch(`${base}/api/bootstrap`)
        .then((r) => r.status)
        .catch(() => 0),
    (status) => status === 200,
  );
  const session = await request<SessionInfo>(
    "/setup",
    {
      setupToken: readFileSync(join(data, "setup-token"), "utf8").trim(),
      username: "acceptance",
      displayName: "Acceptance",
      password: "disposable-mountain-river-password-42",
      locale: "en",
    },
    201,
  );
  csrf = session.csrfToken;
  assert.match(readFileSync(`/proc/${apiProcess.pid}/status`, "utf8"), /Uid:\s+1000\s+1000/);
  assert.match(readFileSync(`/proc/${agentProcess.pid!}/status`, "utf8"), /Uid:\s+0\s+0/);
  pass("root agent and UID 1000 API communicate through group-restricted IPC");
  actor = {
    kind: "user",
    userId: session.user.id,
    username: session.user.username,
    role: "admin",
    sessionId: randomUUID(),
  };
  client = new AgentClient({
    socketPath: socket,
    agentKey: Buffer.from(readFileSync(key, "utf8").trim(), "base64url"),
  });
  client.start();
  await client.waitUntilConnected(15_000);
  const load = async (kind: string) => {
    const source = await request<CatalogView>(
      "/catalogs",
      { name: `Acceptance ${kind}`, url: `http://127.0.0.1:17471/${kind}.yml`, allowPrivate: true },
      201,
    );
    await request(`/catalogs/${source.id}/sync`, {}, 200);
    return (await request<{ apps: CatalogAppView[] }>("/catalogs/apps")).apps.find(
      (app) => app.source.catalogId === source.id,
    )!;
  };
  const normal = await load("normal");
  const install = (app: CatalogAppView, port: number, dataFrom?: string) =>
    request<AppJobView>("/apps/install", {
      appId: app.id,
      snapshot: app.source.ref,
      variables: { APP_SECRET: secret },
      ports: [{ service: "app", index: 0, host: port }],
      acknowledgeRisks: true,
      ...(dataFrom ? { dataFrom, confirmDataFrom: dataFrom } : {}),
    });
  const control = async (id: string, action: string) =>
    finished((await request<AppJobView>(`/apps/${id}/actions`, { action, confirmId: id })).id);
  const first = await install(normal, 18765);
  assert.equal((await finished(first.id)).stage, "succeeded");
  const instance = (await apps()).find((app) => app.id === first.appId)!;
  assert.equal(instance.state, "running");
  assert.equal(instance.source, "host");
  assert.match(instance.images[0]!.digest!, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await (await fetch("http://127.0.0.1:18765")).text(), "persisted-data\n");
  pass("real healthy installation, immutable image identity and nonroot writable data");
  const inline = await load("inline"),
    inlineJob = await install(inline, 18769);
  assert.equal((await finished(inlineJob.id)).stage, "succeeded");
  assert.equal(statfsSync(`/run/everyos/app-configs/${inlineJob.appId}`).type, 0x01021994);
  assert.equal(
    readFileSync(`/run/everyos/app-configs/${inlineJob.appId}/config0`, "utf8"),
    `token=${secret}`,
  );
  assert.ok(
    !readFileSync(`/var/lib/everyos/apps/${inlineJob.appId}/deployment.box`, "utf8").includes(
      secret,
    ),
  );
  pass(
    "embedded secret configuration is readable by nonroot containers and exists only on verified tmpfs",
  );
  const appDir = `/var/lib/everyos/apps/${first.appId}`;
  assert.ok(readFileSync(join(appDir, "deployment.box"), "utf8").startsWith("v1."));
  for (const name of readdirSync(appDir).filter((name) => name !== "data"))
    assert.ok(!readFileSync(join(appDir, name), "utf8").includes(secret));
  assert.ok(!JSON.stringify(await apps()).includes(secret));
  const db = new DatabaseSync(join(data, "everyos.db"), { readOnly: true });
  assert.ok(
    !JSON.stringify(db.prepare("SELECT sealed_compose FROM installed_apps").all()).includes(secret),
  );
  assert.ok(!JSON.stringify(db.prepare("SELECT details FROM audit_events").all()).includes(secret));
  db.close();
  pass("secrets stay encrypted in API and agent records and absent from views/audit");
  assert.equal((await control(first.appId, "stop")).stage, "succeeded");
  assert.equal((await apps()).find((app) => app.id === first.appId)!.state, "stopped");
  assert.equal((await control(first.appId, "start")).stage, "succeeded");
  pass("real stop/start lifecycle");
  docker("tag", "everyos-phase5-fixture:bad", fixtureImage);
  const update = await control(first.appId, "update");
  assert.equal(update.stage, "failed");
  assert.equal(update.rollback, "succeeded");
  assert.equal(await (await fetch("http://127.0.0.1:18765")).text(), "persisted-data\n");
  assert.equal(
    (await apps()).find((app) => app.id === first.appId)!.images[0]!.digest,
    instance.images[0]!.digest,
  );
  pass("failed update restores previous healthy pinned image and preserves data");
  const failed = await install(normal, 18766);
  const failedResult = await finished(failed.id);
  assert.equal(failedResult.stage, "failed");
  assert.equal(failedResult.rollback, "succeeded");
  assert.equal(
    docker(
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=otk-${failed.appId.replaceAll("-", "")}`,
    ),
    "",
  );
  assert.equal(await (await fetch("http://127.0.0.1:18765")).text(), "persisted-data\n");
  pass("failed installation removes only its own containers");
  docker("tag", "everyos-phase5-fixture:good", fixtureImage);
  assert.equal((await control(failed.appId, "retry")).stage, "succeeded");
  pass("failed installation retries without adopting unrelated state");
  assert.equal((await control(first.appId, "stop")).stage, "succeeded");
  const copied = await install(normal, 18767, first.appId);
  assert.equal((await finished(copied.id)).stage, "succeeded");
  assert.equal(await (await fetch("http://127.0.0.1:18767")).text(), "persisted-data\n");
  assert.equal(readFileSync(join(appDir, "data/www/index.html"), "utf8"), "persisted-data\n");
  pass("stopped owned-instance data copies to a new instance without changing its source");
  const foreignId = randomUUID(),
    foreignProject = `otk-${foreignId.replaceAll("-", "")}`;
  const foreign = docker(
    "run",
    "-d",
    "--name",
    "phase5-foreign",
    "--label",
    `com.docker.compose.project=${foreignProject}`,
    "busybox:1.37",
    "sleep",
    "300",
  );
  await assert.rejects(
    client.call(
      "apps.run",
      {
        id: foreignId,
        action: "install",
        compose: "services:\n  app:\n    image: busybox:1.37\n",
        riskOverride: false,
      },
      actor,
    ),
  );
  assert.equal(docker("inspect", "--format", "{{.State.Running}}", foreign), "true");
  await assert.rejects(
    client.call(
      "apps.run",
      {
        id: randomUUID(),
        action: "install",
        compose: "services:\n  app:\n    image: busybox:1.37\n    privileged: true\n",
        riskOverride: false,
      },
      actor,
    ),
  );
  pass("foreign namespace and unapproved host access remain protected");
  const slow = await load("slow"),
    interrupted = await install(slow, 18768);
  await until(
    () => request<AppJobView>(`/apps/jobs/${interrupted.id}`),
    (job) => job.stage === "deploying",
  );
  apiProcess.kill("SIGKILL");
  await once(apiProcess, "exit");
  const journal = await until(
    () => client!.call("apps.inspect", { id: interrupted.appId }, actor),
    (result) => !result.busy && result.lastRun?.jobId === interrupted.id,
    90_000,
  );
  apiProcess = launch("api");
  assert.ok(apiProcess.pid);
  await until(
    () =>
      fetch(`${base}/api/bootstrap`)
        .then((r) => r.status)
        .catch(() => 0),
    (status) => status === 200,
  );
  assert.equal((await request<AppJobView>(`/apps/jobs/${interrupted.id}`)).error, "interrupted");
  const recovered = await request<{ job: AppJobView }>(
    `/apps/${interrupted.appId}/reconcile`,
    {},
    200,
  );
  assert.equal(recovered.job.stage, journal.lastRun!.ok ? "succeeded" : "failed");
  assert.equal(recovered.job.rollback, journal.lastRun!.rollback);
  assert.equal((await control(interrupted.appId, "retry")).stage, "succeeded");
  pass("API crash reconciles the exact durable agent job and supports retry");
  agentProcess.kill("SIGTERM");
  await once(agentProcess, "exit");
  agentProcess = launch("agent");
  assert.ok(agentProcess.pid);
  await delay(700);
  await client.waitUntilConnected(15_000);
  assert.equal((await control(copied.appId, "stop")).stage, "succeeded");
  assert.equal((await control(copied.appId, "start")).stage, "succeeded");
  pass("agent restart retains ownership and decrypts pinned deployment");
  for (const app of await apps())
    assert.equal((await control(app.id, "remove")).stage, "succeeded");
  assert.equal((await apps()).length, 0);
  assert.equal(docker("inspect", "--format", "{{.State.Running}}", foreign), "true");
  assert.equal(readFileSync(join(appDir, "data/www/index.html"), "utf8"), "persisted-data\n");
  pass("removal retains application data and leaves foreign resources running");
  const result = {
    date: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    docker: docker("version", "--format", "{{.Server.Version}}"),
    compose: docker("compose", "version", "--short"),
    apiUid: 1000,
    agentUid: 0,
    checks,
  };
  writeFileSync(
    `${process.env.EVERYOS_ACCEPTANCE_STATE_ROOT ?? "/tmp"}/everyos-phase5-acceptance.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(`Acceptance passed: ${checks.length} scenarios`);
} finally {
  console.log(`Acceptance logs: ${state}`);
  client?.stop();
  catalog.close();
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}
