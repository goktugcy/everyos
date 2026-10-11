import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OperationContext } from "@everyos/agent-protocol";
import { silentLogger } from "@everyos/logger";
import { createDockerSimulator } from "@everyos/system";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedAppManager } from "./managed-apps.ts";
import { createPolicy } from "./policy.ts";
import { SecretBox } from "@everyos/security";
import { randomBytes } from "node:crypto";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const compose =
  "services:\n  app:\n    image: example.invalid/app:1\n    environment:\n      SECRET: literal-test-secret\n";
const context = (role: "admin" | "operator" = "admin"): OperationContext => ({
  actor: { kind: "user", userId: randomUUID(), username: role, role, sessionId: randomUUID() },
  signal: new AbortController().signal,
  logger: silentLogger,
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "everyos-managed-test-")));
  directories.push(dir);
  const docker = createDockerSimulator();
  const run = vi.fn(docker.runCompose.bind(docker));
  docker.runCompose = run;
  const root = join(dir, "apps");
  return {
    manager: new ManagedAppManager({
      docker,
      root,
      isProtected: () => false,
      secrets: new SecretBox(randomBytes(32)),
    }),
    docker,
    run,
    root,
    id: randomUUID(),
  };
}

describe("managed application agent", () => {
  it("refuses an old unpinned deployment update before any image or container mutation", async () => {
    const f = await fixture();
    await f.manager.run({ id: f.id, action: "install", compose, riskOverride: false }, context());
    await unlink(join(f.root, f.id, "deployment.box"));
    f.run.mockClear();
    await expect(
      f.manager.run({ id: f.id, action: "update", compose, riskOverride: false }, context()),
    ).rejects.toThrow("pinned deployment");
    expect(f.run).not.toHaveBeenCalled();
    expect(
      await f.manager.run({ id: f.id, action: "retry", compose, riskOverride: false }, context()),
    ).toMatchObject({ ok: true });
  });
  it("serializes data copying with generic Docker lifecycle actions on its source", async () => {
    const f = await fixture();
    const hold = Promise.withResolvers<void>();
    const active = f.manager.withProjectLock(`otk-${f.id.replaceAll("-", "")}`, () => hold.promise);
    await expect(
      f.manager.run(
        { id: randomUUID(), action: "install", compose, riskOverride: false, dataFrom: f.id },
        context(),
      ),
    ).rejects.toThrow("Source application operation");
    await expect(
      f.manager.withProjectLock(`otk-${f.id.replaceAll("-", "")}`, () => Promise.resolve()),
    ).rejects.toThrow("in progress");
    hold.resolve();
    await active;
    expect((await f.manager.inspect(f.id)).busy).toBe(false);
  });
  it("uses a private namespace and removes transient secrets after success", async () => {
    const f = await fixture();
    expect(
      await f.manager.run({ id: f.id, action: "install", compose, riskOverride: false }, context()),
    ).toMatchObject({ source: "simulated", ok: true, rollback: "not-needed" });
    const containers = await f.docker.listContainers();
    expect(containers.some((entry) => entry.project === `otk-${f.id.replaceAll("-", "")}`)).toBe(
      true,
    );
    expect(await readdir(join(f.root, f.id))).toEqual([
      "data",
      "deployment.box",
      "last-run.json",
      "ownership.json",
    ]);
    expect(await readFile(join(f.root, f.id, "ownership.json"), "utf8")).not.toContain(
      "literal-test-secret",
    );
    expect(
      await f.manager.run(
        { id: f.id, action: "stop", compose, riskOverride: false },
        context("operator"),
      ),
    ).toMatchObject({ ok: true });
    await expect(
      f.manager.run(
        {
          id: f.id,
          action: "start",
          compose: compose.replace("app:1", "app:2"),
          riskOverride: false,
        },
        context(),
      ),
    ).rejects.toThrow("mismatch");
  });
  it("rolls back only its own failed installation and never returns CLI secrets", async () => {
    const f = await fixture();
    f.run
      .mockResolvedValueOnce({ ok: false, output: "SECRET=do-not-disclose" })
      .mockResolvedValueOnce({ ok: true, output: "rollback output" });
    const result = await f.manager.run(
      { id: f.id, action: "install", compose, riskOverride: false },
      context(),
    );
    expect(result).toMatchObject({ ok: false, rollback: "succeeded" });
    expect(JSON.stringify(result)).not.toContain("do-not-disclose");
    expect(f.run.mock.calls.map((call) => call[3])).toEqual(["up", "down"]);
    expect(f.run.mock.calls.every((call) => call[0] === `otk-${f.id.replaceAll("-", "")}`)).toBe(
      true,
    );
    expect(await readdir(join(f.root, f.id))).toEqual(["data", "last-run.json", "ownership.json"]);
  });
  it("reports rollback failure and rechecks administrator risk approval", async () => {
    const f = await fixture();
    const risky = `${compose}    privileged: true\n`;
    await expect(
      f.manager.run(
        { id: f.id, action: "install", compose: risky, riskOverride: true },
        context("operator"),
      ),
    ).rejects.toThrow("Administrator");
    await expect(
      f.manager.run(
        { id: f.id, action: "install", compose: risky, riskOverride: false },
        context(),
      ),
    ).rejects.toThrow("Administrator");
    f.run.mockRejectedValue(new Error("CLI SECRET=do-not-disclose"));
    expect(
      await f.manager.run(
        { id: f.id, action: "install", compose: risky, riskOverride: true },
        context(),
      ),
    ).toMatchObject({ ok: false, rollback: "failed" });
  });
  it("rejects foreign projects, symlink roots, hooks and unresolved variables", async () => {
    const f = await fixture();
    await expect(
      f.manager.run({ id: f.id, action: "start", compose, riskOverride: false }, context()),
    ).rejects.toThrow("ownership");
    await expect(
      f.manager.run(
        {
          id: randomUUID(),
          action: "install",
          compose: `${compose}    post_start: [{command: evil}]\n`,
          riskOverride: false,
        },
        context(),
      ),
    ).rejects.toThrow("Unsupported");
    await expect(
      f.manager.run(
        {
          id: randomUUID(),
          action: "install",
          compose: compose.replace("literal-test-secret", "${UNKNOWN}"),
          riskOverride: false,
        },
        context(),
      ),
    ).rejects.toThrow("unresolved");
    const other = await mkdtemp(join(tmpdir(), "everyos-link-target-"));
    directories.push(other);
    const link = join(other, "link");
    await symlink(f.root, link);
    const manager = new ManagedAppManager({
      docker: f.docker,
      root: link,
      isProtected: () => false,
      secrets: new SecretBox(randomBytes(32)),
    });
    await expect(
      manager.run({ id: randomUUID(), action: "install", compose, riskOverride: false }, context()),
    ).rejects.toThrow("private");
  });
  it("denies host mutations in development mode", () => {
    const policy = createPolicy({
      mode: "development",
      isProtected: () => false,
      servicesSource: "simulated",
      dockerSource: "host",
    });
    expect(policy("apps.run", {}, context().actor).allowed).toBe(false);
  });
  it("restores the previous encrypted deployment after an unhealthy update", async () => {
    const f = await fixture();
    const oldInput = compose.replace("app:1", `app@sha256:${"a".repeat(64)}`);
    const newInput = compose.replace("app:1", `app@sha256:${"b".repeat(64)}`);
    f.docker.resolveImages = vi
      .fn()
      .mockResolvedValueOnce({ compose: oldInput, images: [] })
      .mockResolvedValueOnce({ compose: newInput, images: [] });
    const firstJob = randomUUID();
    await f.manager.run(
      { id: f.id, action: "install", compose, riskOverride: false, jobId: firstJob },
      context(),
    );
    const sealed = await readFile(join(f.root, f.id, "deployment.box"), "utf8");
    expect(sealed).not.toContain("literal-test-secret");
    f.run
      .mockResolvedValueOnce({ ok: false, output: "private" })
      .mockResolvedValueOnce({ ok: true, output: "" });
    const jobId = randomUUID();
    expect(
      await f.manager.run(
        { id: f.id, action: "update", compose, riskOverride: false, jobId },
        context(),
      ),
    ).toMatchObject({ ok: false, rollback: "succeeded" });
    expect(f.run.mock.calls.at(-2)?.[5]).toContain(`app@sha256:${"b".repeat(64)}`);
    expect(f.run.mock.calls.at(-1)?.[5]).toContain(`app@sha256:${"a".repeat(64)}`);
    expect(await readFile(join(f.root, f.id, "deployment.box"), "utf8")).toBe(sealed);
    expect(await f.manager.inspect(f.id)).toMatchObject({
      ownership: "deployed",
      busy: false,
      lastRun: { jobId, action: "update", ok: false, rollback: "succeeded" },
    });
  });
  it("repairs interrupted marker preparation only with its private install intent", async () => {
    const f = await fixture();
    await f.manager.run({ id: f.id, action: "install", compose, riskOverride: false }, context());
    await unlink(join(f.root, f.id, "ownership.json"));
    expect((await f.manager.inspect(f.id)).ownership).toBe("prepared");
    await expect(
      f.manager.run(
        {
          id: f.id,
          action: "retry",
          compose: compose.replace("app:1", "app:2"),
          riskOverride: false,
        },
        context(),
      ),
    ).rejects.toThrow("ownership");
    expect(
      await f.manager.run({ id: f.id, action: "retry", compose, riskOverride: false }, context()),
    ).toMatchObject({ ok: true });
    await f.manager.run({ id: f.id, action: "remove", compose, riskOverride: false }, context());
    await expect(
      f.manager.run({ id: f.id, action: "retry", compose, riskOverride: false }, context()),
    ).rejects.toThrow("mismatch");
  });
  it("rejects live data sources and links while preserving source bytes", async () => {
    const f = await fixture(),
      source = f.id;
    await f.manager.run({ id: source, action: "install", compose, riskOverride: false }, context());
    const file = join(f.root, source, "data", "original");
    await writeFile(file, "retain-source");
    const target = randomUUID();
    await expect(
      f.manager.run(
        { id: target, action: "install", compose, riskOverride: false, dataFrom: source },
        context(),
      ),
    ).rejects.toThrow("stopped");
    await f.manager.run({ id: source, action: "stop", compose, riskOverride: false }, context());
    await symlink(file, join(f.root, source, "data", "link"));
    await expect(
      f.manager.run(
        { id: target, action: "retry", compose, riskOverride: false, dataFrom: source },
        context(),
      ),
    ).rejects.toThrow("link");
    await unlink(join(f.root, source, "data", "link"));
    expect(
      await f.manager.run(
        { id: target, action: "retry", compose, riskOverride: false, dataFrom: source },
        context(),
      ),
    ).toMatchObject({ ok: true });
    expect(await readFile(file, "utf8")).toBe("retain-source");
    expect(await readFile(join(f.root, target, "data", "original"), "utf8")).toBe("retain-source");
  });
});
