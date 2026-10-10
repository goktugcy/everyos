import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Exec from "../exec.ts";
import { runCapture } from "../exec.ts";
import { resolveManagedImages } from "./managed-images.ts";

vi.mock("../exec.ts", async (original) => ({
  ...(await original<typeof Exec>()),
  findExecutable: vi.fn(() => Promise.resolve("/usr/bin/docker")),
  runCapture: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const sha = "a".repeat(64),
  reference = `example.invalid/app@sha256:${sha}`;
const metadata = {
  Id: `sha256:${"b".repeat(64)}`,
  RepoDigests: [reference],
  Os: "linux",
  Architecture: "arm64",
};
const compose = "services:\n  app:\n    image: example.invalid/app:latest\n";
describe("managed image resolution", () => {
  it("pins the exact platform and daemon artifact without secret command arguments", async () => {
    vi.mocked(runCapture).mockResolvedValue({ exitCode: 0, output: JSON.stringify(metadata) });
    const result = await resolveManagedImages("/run/selected.sock", compose, "linux/arm64", false);
    expect(result.images).toEqual([
      { reference, digest: `sha256:${sha}`, platform: "linux/arm64" },
    ]);
    expect(result.compose).toContain(reference);
    expect(result.compose).toContain("pull_policy: never");
    expect(vi.mocked(runCapture).mock.calls[0]?.[2].env).toMatchObject({
      DOCKER_HOST: "unix:///run/selected.sock",
    });
  });
  it("pulls the selected architecture on update and fails before deployment on pull errors", async () => {
    vi.mocked(runCapture).mockImplementation((_binary, args) =>
      Promise.resolve(
        args.includes("pull")
          ? { exitCode: 1, output: "credential must remain private" }
          : { exitCode: 0, output: JSON.stringify(metadata) },
      ),
    );
    await expect(
      resolveManagedImages("/run/selected.sock", compose, "linux/arm64", true),
    ).rejects.toThrow("Image pull failed");
    expect(vi.mocked(runCapture).mock.calls[1]).toMatchObject([
      "/usr/bin/docker",
      ["image", "pull", "--platform", "linux/arm64", "example.invalid/app:latest"],
      { maxOutputBytes: 0 },
    ]);
  });
  it("rejects a wrong platform and a mismatched requested digest", async () => {
    vi.mocked(runCapture).mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify({ ...metadata, Architecture: "amd64" }),
    });
    await expect(
      resolveManagedImages("/run/selected.sock", compose, "linux/arm64", false),
    ).rejects.toThrow("platform mismatch");
    vi.mocked(runCapture).mockResolvedValue({ exitCode: 0, output: JSON.stringify(metadata) });
    await expect(
      resolveManagedImages(
        "/run/selected.sock",
        compose.replace(
          "example.invalid/app:latest",
          `example.invalid/app@sha256:${"c".repeat(64)}`,
        ),
        "linux/arm64",
        false,
      ),
    ).rejects.toThrow("digest mismatch");
  });
  it("retains an explicitly local image by immutable ID without pulling", async () => {
    vi.mocked(runCapture).mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify({ ...metadata, RepoDigests: [] }),
    });
    const result = await resolveManagedImages(
      "/run/selected.sock",
      compose + "    pull_policy: never\n",
      "linux/arm64",
      true,
    );
    expect(result.images[0]?.reference).toBe(metadata.Id);
    expect(vi.mocked(runCapture).mock.calls).toHaveLength(1);
  });
});
