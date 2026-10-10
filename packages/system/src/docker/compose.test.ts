import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Exec from "../exec.ts";
import { runCapture, SAFE_ENV } from "../exec.ts";
import { runCompose } from "./compose.ts";

vi.mock("../exec.ts", async (importOriginal) => {
  const original = await importOriginal<typeof Exec>();
  return {
    ...original,
    findExecutable: vi.fn(() => Promise.resolve("/usr/bin/docker")),
    runCapture: vi.fn(() => Promise.resolve({ exitCode: 0, output: "5.4.0\n" })),
  };
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("controlled Compose execution", () => {
  it("uses the discovery socket and never removes volumes or images", async () => {
    const directory = mkdtempSync(join(tmpdir(), "otk-compose-run-"));
    directories.push(directory);
    const file = join(directory, "compose.yaml");
    writeFileSync(file, "services:\n  web:\n    image: nginx\n");
    const signal = new AbortController().signal;
    await runCompose("media", directory, [file], "down", "/run/custom-docker.sock", signal);
    const [binary, args, options] = vi.mocked(runCapture).mock.calls.at(-1)!;
    expect(binary).toBe("/usr/bin/docker");
    expect(args).toEqual([
      "compose",
      "--ansi",
      "never",
      "--project-name",
      "media",
      "--project-directory",
      directory,
      "--file",
      file,
      "down",
    ]);
    expect(options).toMatchObject({
      cwd: directory,
      signal,
      env: {
        ...SAFE_ENV,
        DOCKER_HOST: "unix:///run/custom-docker.sock",
        COMPOSE_PROGRESS: "plain",
      },
    });
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(600_000);
  });

  it("does not recreate containers when the pull step of an update fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "otk-compose-run-"));
    directories.push(directory);
    const file = join(directory, "compose.yaml");
    writeFileSync(file, "services:\n  web:\n    image: nginx\n");
    vi.mocked(runCapture).mockImplementation((_file, args) =>
      Promise.resolve(
        args.includes("pull")
          ? { exitCode: 1, output: "registry unavailable" }
          : { exitCode: 0, output: "5.4.0\n" },
      ),
    );
    await expect(
      runCompose("media", directory, [file], "update", "/run/custom-docker.sock"),
    ).resolves.toEqual({ ok: false, output: "registry unavailable" });
    expect(vi.mocked(runCapture).mock.calls.some(([, args]) => args.includes("up"))).toBe(false);
  });
});
