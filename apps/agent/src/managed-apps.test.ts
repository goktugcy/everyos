import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OperationContext } from "@otuken/agent-protocol";
import { silentLogger } from "@otuken/logger";
import { createDockerSimulator } from "@otuken/system";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedAppManager } from "./managed-apps.ts";
import { createPolicy } from "./policy.ts";

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
  const dir = await realpath(await mkdtemp(join(tmpdir(), "otuken-managed-test-")));
  directories.push(dir);
  const docker = createDockerSimulator();
  const run = vi.fn(docker.runCompose.bind(docker));
  docker.runCompose = run;
  const root = join(dir, "apps");
  return {
    manager: new ManagedAppManager({ docker, root, isProtected: () => false }),
    docker,
    run,
    root,
    id: randomUUID(),
  };
}

describe("managed application agent", () => {
  it("uses a private namespace and removes transient secrets after success", async () => {
    const f = await fixture();
    expect(
      await f.manager.run({ id: f.id, action: "install", compose, riskOverride: false }, context()),
    ).toEqual({ source: "simulated", ok: true, rollback: "not-needed" });
    const containers = await f.docker.listContainers();
    expect(containers.some((entry) => entry.project === `otk-${f.id.replaceAll("-", "")}`)).toBe(
      true,
    );
    expect(await readdir(join(f.root, f.id))).toEqual(["data", "ownership.json"]);
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
    expect(await readdir(join(f.root, f.id))).toEqual(["data", "ownership.json"]);
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
    const other = await mkdtemp(join(tmpdir(), "otuken-link-target-"));
    directories.push(other);
    const link = join(other, "link");
    await symlink(f.root, link);
    const manager = new ManagedAppManager({
      docker: f.docker,
      root: link,
      isProtected: () => false,
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
});
