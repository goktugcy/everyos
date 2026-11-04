import type * as ExecModule from "../exec.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ candidate: "1.4.5-1~bpo12+1", current: "0.1.45" }));
vi.mock("../exec.ts", async (original) => {
  const actual = await original<typeof ExecModule>();
  return {
    ...actual,
    findExecutable: vi.fn((name: string) => Promise.resolve(`/fixture/bin/${name}`)),
    runCommand: vi.fn((_file: string, args: string[]) =>
      Promise.resolve(
        args[0] === "policy"
          ? `borgbackup:\n  Installed: (none)\n  Candidate: ${state.candidate}\n  Version table:\n`
          : "Package: borgbackup\nDescription: Fixture package\n",
      ),
    ),
    runCapture: vi.fn((file: string) =>
      Promise.resolve({
        exitCode: 0,
        output: file.endsWith("dpkg-query") ? state.current : "1 newly installed",
      }),
    ),
  };
});
import { runCapture } from "../exec.ts";
import { createAptManager, isSupportedBorgPackageVersion } from "./manager.ts";

describe("fixed BorgBackup package installation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.candidate = "1.4.5-1~bpo12+1";
    state.current = "0.1.45";
  });
  it("accepts supported Debian revisions and rejects old, prerelease and Borg 2 packages", () => {
    for (const version of ["1.2.5", "1.2.8-3", "1.4.5-1~bpo12+1", "1:1.4.5-2"])
      expect(isSupportedBorgPackageVersion(version)).toBe(true);
    for (const version of [
      "1.2.4-7",
      "1.1.18",
      "1.4.5~rc1-1",
      "2.0.0",
      "1.4.5;echo hi",
      "--option",
    ])
      expect(isSupportedBorgPackageVersion(version)).toBe(false);
  });
  it("installs a fixed repository version, pins EveryOS and preserves package safety flags", async () => {
    expect(await createAptManager().installBorg(new AbortController().signal)).toEqual({
      ok: true,
      busy: false,
    });
    const call = vi.mocked(runCapture).mock.calls.find(([file]) => file.endsWith("apt-get"))!;
    expect(call[1]).toEqual(
      expect.arrayContaining([
        "--no-remove",
        "--no-install-recommends",
        "install",
        "--",
        "borgbackup=1.4.5-1~bpo12+1",
        "everyos=0.1.45",
        "Dpkg::Options::=--force-confold",
      ]),
    );
    expect(call[1]).not.toContain("--only-upgrade");
    expect(call[2]?.env).toMatchObject({
      DEBIAN_FRONTEND: "noninteractive",
      NEEDRESTART_MODE: "l",
    });
  });
  it("refuses unsupported or unavailable candidates before starting APT", async () => {
    for (const candidate of ["1.2.4-7", "2.0.0", "(none)"]) {
      state.candidate = candidate;
      await expect(createAptManager().installBorg(new AbortController().signal)).rejects.toThrow(
        candidate === "(none)" ? "BORG_PACKAGE_UNAVAILABLE" : "BORG_PACKAGE_VERSION",
      );
    }
    expect(
      vi.mocked(runCapture).mock.calls.filter(([file]) => file.endsWith("apt-get")),
    ).toHaveLength(0);
  });
  it("refuses an unrecognized EveryOS version rather than allowing an unsigned upgrade", async () => {
    state.current = "invalid-installed-version";
    await expect(createAptManager().installBorg(new AbortController().signal)).rejects.toThrow(
      "BORG_INSTALL_EVERYOS_VERSION",
    );
    expect(
      vi.mocked(runCapture).mock.calls.filter(([file]) => file.endsWith("apt-get")),
    ).toHaveLength(0);
  });
});
