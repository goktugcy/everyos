import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareRemoteRepository,
  remoteAccessRepository,
  installRemoteAccessProvider,
} from "./install.ts";
import { createAptSimulator } from "../simulated/apt-simulator.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "everyos-remote-repo-"));
  roots.push(root);
  await mkdir(join(root, "etc/apt/sources.list.d"), { recursive: true });
  await mkdir(join(root, "usr/share/keyrings"), { recursive: true });
  await writeFile(join(root, "etc/os-release"), "ID=ubuntu\nVERSION_CODENAME=noble\n");
  return {
    root,
    checkSafe: vi.fn(async () => {}),
    fetchKey: vi.fn(async () =>
      readFile(new URL("./fixtures/netbird-repository.asc", import.meta.url)),
    ),
  };
}
describe("fixed remote access repositories", () => {
  it("uses official signed repositories and refuses unsupported distributions or unsafe codenames", () => {
    expect(remoteAccessRepository("netbird", "ID=debian\nVERSION_CODENAME=bookworm")).toMatchObject(
      { repository: "https://pkgs.netbird.io/debian", suite: "stable" },
    );
    expect(remoteAccessRepository("tailscale", "ID=ubuntu\nVERSION_CODENAME=noble")).toMatchObject({
      repository: "https://pkgs.tailscale.com/stable/ubuntu",
      suite: "noble",
    });
    expect(() =>
      remoteAccessRepository("tailscale", 'ID=ubuntu\nVERSION_CODENAME="../../evil"'),
    ).toThrow("REMOTE_INSTALL_UNSUPPORTED");
    expect(() => remoteAccessRepository("netbird", "ID=fedora")).toThrow(
      "REMOTE_INSTALL_UNSUPPORTED",
    );
  });
  it("verifies the public key before writing and preserves an existing administrator repository", async () => {
    const options = await fixture();
    await prepareRemoteRepository("netbird", true, signal(), options);
    const source = await readFile(
      join(options.root, "etc/apt/sources.list.d/everyos-netbird.sources"),
      "utf8",
    );
    expect(source).toContain("Signed-By: /usr/share/keyrings/everyos-netbird.asc");
    expect(source).not.toMatch(/trusted=yes|http:\/\//);
    await prepareRemoteRepository("netbird", false, signal(), options);
    expect(options.fetchKey).toHaveBeenCalledTimes(1);
    expect(options.checkSafe).toHaveBeenCalledTimes(2);
    expect(
      await readFile(join(options.root, "etc/apt/sources.list.d/everyos-netbird.sources"), "utf8"),
    ).toBe(source);
  });
  it("requires repository consent and stops before writes on bad key or unsafe host view", async () => {
    const options = await fixture();
    await expect(prepareRemoteRepository("netbird", false, signal(), options)).rejects.toThrow(
      "REMOTE_REPOSITORY_REQUIRED",
    );
    await expect(
      prepareRemoteRepository("netbird", true, signal(), {
        ...options,
        fetchKey: () => Promise.resolve(Buffer.from("tampered key")),
      }),
    ).rejects.toThrow("REMOTE_REPOSITORY_KEY");
    options.checkSafe.mockRejectedValue(new Error("PACKAGE_ENVIRONMENT_UNSAFE"));
    await expect(prepareRemoteRepository("netbird", true, signal(), options)).rejects.toThrow(
      "PACKAGE_ENVIRONMENT_UNSAFE",
    );
    expect(await readdir(join(options.root, "usr/share/keyrings"))).toEqual([]);
    expect(await readdir(join(options.root, "etc/apt/sources.list.d"))).toEqual([]);
  });
  it("does not replace existing files or follow a key symlink, and respects pre-aborted requests", async () => {
    const options = await fixture(),
      dir = join(options.root, "usr/share/keyrings");
    const target = join(options.root, "important");
    await writeFile(target, "untouched");
    await symlink(target, join(dir, "everyos-netbird.asc"));
    await expect(prepareRemoteRepository("netbird", true, signal(), options)).rejects.toThrow(
      "REMOTE_REPOSITORY_CONFLICT",
    );
    expect(await readFile(target, "utf8")).toBe("untouched");
    await expect(
      prepareRemoteRepository("netbird", true, AbortSignal.abort(), options),
    ).rejects.toThrow();
    const second = await fixture();
    await writeFile(
      join(second.root, "etc/apt/sources.list.d/everyos-netbird.sources"),
      "administrator content",
    );
    await expect(prepareRemoteRepository("netbird", true, signal(), second)).rejects.toThrow(
      "REMOTE_REPOSITORY_CONFLICT",
    );
    expect(await readdir(join(second.root, "usr/share/keyrings"))).toEqual([]);
  });
  it("never uses a simulated package manager for real installation", async () => {
    const events = [];
    for await (const event of installRemoteAccessProvider(
      createAptSimulator(),
      "netbird",
      true,
      signal(),
    ))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ ok: false, error: "REMOTE_INSTALL_UNSUPPORTED" });
  });
});
