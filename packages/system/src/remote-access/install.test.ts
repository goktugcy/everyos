import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  chmod,
  stat,
  link,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareRemoteRepository,
  remoteAccessRepository,
  installRemoteAccessProvider,
  remoteAccessRefreshFailure,
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
  it("makes public APT files readable under the production agent's private umask", async () => {
    const options = await fixture();
    for (const directory of ["usr/share/keyrings", "etc/apt/sources.list.d"])
      await rm(join(options.root, directory), { recursive: true });
    // umask is process-wide: use a child rather than changing the parallel test runner's mask.
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { readFile, writeFile } from 'node:fs/promises';
      import { prepareRemoteRepository } from ${JSON.stringify(new URL("./install.ts", import.meta.url).href)};
      process.umask(0o077);
      await prepareRemoteRepository('netbird', true, new AbortController().signal, {
        root: process.argv[1], checkSafe: () => Promise.resolve(),
        fetchKey: () => readFile(new URL(${JSON.stringify(new URL("./fixtures/netbird-repository.asc", import.meta.url).href)}))
      });
      if (process.umask() !== 0o077) throw new Error('The private agent umask changed');
      await writeFile(process.argv[1] + '/private-probe', 'fixture', { flag: 'wx' });
    `,
        options.root,
      ],
      { timeout: 10_000, maxBuffer: 4096 },
    );
    for (const file of [
      "usr/share/keyrings/everyos-netbird.asc",
      "etc/apt/sources.list.d/everyos-netbird.sources",
    ])
      expect((await stat(join(options.root, file))).mode & 0o777).toBe(0o644);
    for (const directory of ["usr/share/keyrings", "etc/apt/sources.list.d"])
      expect((await stat(join(options.root, directory))).mode & 0o777).toBe(0o755);
    expect((await stat(join(options.root, "private-probe"))).mode & 0o777).toBe(0o600);
  });
  it("repairs exact EveryOS-owned files from an earlier restricted-umask installation on retry", async () => {
    const options = await fixture();
    await prepareRemoteRepository("netbird", true, signal(), options);
    const files = [
      "usr/share/keyrings/everyos-netbird.asc",
      "etc/apt/sources.list.d/everyos-netbird.sources",
    ].map((file) => join(options.root, file));
    const before = await Promise.all(files.map((file) => readFile(file)));
    for (const file of files) await chmod(file, 0o600);
    await prepareRemoteRepository("netbird", false, signal(), options);
    for (let i = 0; i < files.length; i++) {
      expect((await stat(files[i]!)).mode & 0o777).toBe(0o644);
      expect(await readFile(files[i]!)).toEqual(before[i]);
    }
    expect(options.fetchKey).toHaveBeenCalledOnce();
  });
  it("leaves altered, symlinked or hard-linked files and their permissions untouched", async () => {
    for (const change of ["source", "key", "symlink", "hardlink"] as const) {
      const options = await fixture();
      await prepareRemoteRepository("netbird", true, signal(), options);
      const source = join(options.root, "etc/apt/sources.list.d/everyos-netbird.sources");
      const key = join(options.root, "usr/share/keyrings/everyos-netbird.asc");
      await chmod(source, 0o600);
      await chmod(key, 0o600);
      if (change === "source")
        await writeFile(
          source,
          "# Administrator modified this file\n" + (await readFile(source, "utf8")),
        );
      if (change === "key") await writeFile(key, "untrusted replacement");
      if (change === "hardlink") await link(source, join(options.root, "administrator-link"));
      if (change === "symlink") {
        const target = join(options.root, "administrator-source");
        await writeFile(target, await readFile(source), { mode: 0o600 });
        await rm(source);
        await symlink(target, source);
      }
      const before = await Promise.all([readFile(source), readFile(key)]);
      await expect(prepareRemoteRepository("netbird", true, signal(), options)).rejects.toThrow(
        "REMOTE_REPOSITORY_CONFLICT",
      );
      expect((await stat(source)).mode & 0o777).toBe(0o600);
      expect((await stat(key)).mode & 0o777).toBe(0o600);
      expect(await Promise.all([readFile(source), readFile(key)])).toEqual(before);
    }
  });
  it("preserves administrator repositories and repairs a verified orphaned EveryOS key", async () => {
    const options = await fixture();
    const file = join(options.root, "etc/apt/sources.list.d/admin-netbird.list");
    const contents =
      "deb [signed-by=/etc/apt/keyrings/admin-key.gpg] https://pkgs.netbird.io/debian stable main\n";
    await writeFile(file, contents, { mode: 0o600 });
    await prepareRemoteRepository("netbird", false, signal(), options);
    expect(await readFile(file, "utf8")).toBe(contents);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(options.fetchKey).not.toHaveBeenCalled();
    const second = await fixture(),
      key = join(second.root, "usr/share/keyrings/everyos-netbird.asc");
    await writeFile(key, await second.fetchKey(), { mode: 0o600 });
    await prepareRemoteRepository("netbird", true, signal(), second);
    expect((await stat(key)).mode & 0o777).toBe(0o644);
  });
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
  it("classifies refresh failures without returning private repository or proxy credentials", () => {
    const credentials =
      "https://private-user:private-password@private.example.test?token=private-token";
    for (const [output, code] of [
      ["NO_PUBKEY AABBCCDD", "REMOTE_REFRESH_SIGNATURE"],
      ["keyring ignored as it is not readable by user _apt", "REMOTE_REFRESH_PERMISSIONS"],
      ["Temporary failure resolving mirror.example.test", "REMOTE_REFRESH_NETWORK"],
      ["The repository does not have a Release file.", "REMOTE_REFRESH_REPOSITORY"],
      ["Conflicting values set for option Signed-By", "REMOTE_REFRESH_REPOSITORY"],
      ["No space left on device", "REMOTE_REFRESH_SPACE"],
      ["unrecognized failure", "REMOTE_REFRESH_FAILED"],
    ])
      expect(remoteAccessRefreshFailure(`${output} ${credentials}`)).toBe(code);
  });
  it("does not install after a failed refresh and retains a safe, actionable reason", async () => {
    for (const busy of [false, true]) {
      const options = await fixture();
      const install = vi.fn(() => Promise.resolve({ ok: true, busy: false }));
      const apt = {
        ...createAptSimulator(),
        source: "host" as const,
        refresh: () =>
          Promise.resolve({
            ok: false,
            busy,
            output: "GPG error: private-repository?secret=do-not-return NO_PUBKEY AABB",
          }),
        installRemoteAccess: install,
      };
      const events = [];
      for await (const event of installRemoteAccessProvider(apt, "netbird", true, signal(), {
        ...options,
        find: () => Promise.resolve(null),
      }))
        events.push(event);
      expect(events.at(-1)).toEqual({
        type: "done",
        ok: false,
        error: busy ? "REMOTE_PACKAGE_BUSY" : "REMOTE_REFRESH_SIGNATURE",
      });
      expect(install).not.toHaveBeenCalled();
      expect(JSON.stringify(events)).not.toContain("do-not-return");
    }
  });
  it("refreshes the signed source, installs only the selected provider and verifies the new CLI", async () => {
    const options = await fixture();
    const install = vi.fn(() => Promise.resolve({ ok: true, busy: false }));
    const apt = {
      ...createAptSimulator(),
      source: "host" as const,
      refresh: vi.fn(() => Promise.resolve({ ok: true, busy: false, output: "" })),
      installRemoteAccess: install,
    };
    const find = vi
      .fn(() => Promise.resolve<string | null>("/fixture/netbird"))
      .mockResolvedValueOnce(null);
    const events = [];
    for await (const event of installRemoteAccessProvider(apt, "netbird", true, signal(), {
      ...options,
      find,
    }))
      events.push(event);
    expect(apt.refresh).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith("netbird", expect.any(AbortSignal));
    expect(events.at(-1)).toEqual({ type: "done", ok: true, error: null });
    expect(find.mock.calls).toHaveLength(2);
  });
});
