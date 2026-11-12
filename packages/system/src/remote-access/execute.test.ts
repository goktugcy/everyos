import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommandError, findExecutable, runCapture } from "../exec.ts";
import { VPN_CREDENTIAL_EXEC } from "./credential-exec.ts";
import { executeRemoteMutation, remoteCommandFailure } from "./execute.ts";

const signal = () => new AbortController().signal;
describe("remote command diagnostics", () => {
  it("returns static, specific reasons without exposing keys, private URLs or proxy tokens", () => {
    for (const [output, reason] of [
      [
        "failed to read setup key file: open /dev/stdin: no such device or address",
        "REMOTE_CREDENTIAL_INPUT_UNAVAILABLE",
      ],
      ["EVERYOS_VPN_CREDENTIAL_INPUT_UNAVAILABLE", "REMOTE_CREDENTIAL_INPUT_UNAVAILABLE"],
      ["invalid setup-key or no sso information provided", "REMOTE_AUTH_REJECTED"],
      ["setup key is expired", "REMOTE_AUTH_REJECTED"],
      [
        "peer is already registered by a different User or a Setup Key",
        "REMOTE_PEER_IDENTITY_CONFLICT",
      ],
      ["x509: certificate signed by unknown authority", "REMOTE_CERTIFICATE_FAILED"],
      [
        "changing management URL is disabled by --disable-update-settings",
        "REMOTE_CONFIGURATION_LOCKED",
      ],
      ["dial unix /var/run/netbird.sock: connect: connection refused", "REMOTE_DAEMON_UNAVAILABLE"],
      ["lookup api.netbird.io: no such host", "REMOTE_NETWORK_UNREACHABLE"],
      ["rpc error: context deadline exceeded", "REMOTE_NETWORK_UNREACHABLE"],
      ["unrecognized failure", "REMOTE_COMMAND_FAILED"],
    ])
      expect(
        remoteCommandFailure("netbird", `${output}\nhttps://user:secret@private.test?token=secret`),
      ).toBe(reason);
    expect(remoteCommandFailure("tailscale", "setup key expired")).toBe("REMOTE_COMMAND_FAILED");
    for (const [output, reason] of [
      ["invalid authkey: fixture-secret", "REMOTE_AUTH_REJECTED"],
      ["failed to connect to local tailscaled", "REMOTE_DAEMON_UNAVAILABLE"],
      [
        "changing settings via tailscale up requires mentioning all non-default flags",
        "REMOTE_SETTINGS_NOT_APPLIED",
      ],
      ["device approval required", "REMOTE_APPROVAL_REQUIRED"],
      ["timeout waiting for tailscaled to enter Running", "REMOTE_COMMAND_TIMEOUT"],
      ["flag provided but not defined", "REMOTE_VERSION_UNSUPPORTED"],
      ["lookup control.example: no such host", "REMOTE_NETWORK_UNREACHABLE"],
    ])
      expect(remoteCommandFailure("tailscale", output!)).toBe(reason);
  });
  it("uses the packaged Python runtime only for credentials, and keeps secrets out of argv and env", async () => {
    const find = vi.fn((name: string) => Promise.resolve(`/fixture/${name}`));
    const capture = vi.fn<typeof runCapture>(() =>
      Promise.resolve({ exitCode: 0, output: "secret-fixture-key" }),
    );
    expect(
      await executeRemoteMutation(
        { find, capture },
        "netbird",
        ["up", "--setup-key-file", "/dev/stdin"],
        signal(),
        "secret-fixture-key",
      ),
    ).toBeNull();
    const [file, args, options] = capture.mock.calls[0]!;
    expect(file).toBe("/fixture/python3");
    expect(args).toEqual([
      "-I",
      "-c",
      VPN_CREDENTIAL_EXEC,
      "/fixture/netbird",
      "up",
      "--setup-key-file",
      "/dev/stdin",
    ]);
    expect(JSON.stringify([file, args, options.env])).not.toContain("secret-fixture-key");
    expect(options.input).toBe("secret-fixture-key\n");
    expect(
      await executeRemoteMutation({ find, capture }, "netbird", ["down"], signal()),
    ).toBeNull();
    expect(capture.mock.calls[1]?.slice(0, 2)).toEqual(["/fixture/netbird", ["down"]]);
  });
  it("fails safely when tools are absent, commands time out or capture errors contain secrets", async () => {
    const capture = vi.fn<typeof runCapture>();
    expect(
      await executeRemoteMutation(
        { find: () => Promise.resolve(null), capture },
        "netbird",
        ["up"],
        signal(),
        "key",
      ),
    ).toBe("REMOTE_NOT_INSTALLED");
    expect(
      await executeRemoteMutation(
        {
          find: (name) => Promise.resolve(name === "netbird" ? "/fixture/netbird" : null),
          capture,
        },
        "netbird",
        ["up"],
        signal(),
        "key",
      ),
    ).toBe("REMOTE_CREDENTIAL_INPUT_UNAVAILABLE");
    expect(capture).not.toHaveBeenCalled();
    const find = () => Promise.resolve("/fixture/netbird");
    capture.mockRejectedValueOnce(new CommandError("timeout", "secret timeout details"));
    expect(await executeRemoteMutation({ find, capture }, "netbird", ["down"], signal())).toBe(
      "REMOTE_COMMAND_TIMEOUT",
    );
    capture.mockRejectedValueOnce(new Error("secret connection details"));
    expect(await executeRemoteMutation({ find, capture }, "netbird", ["down"], signal())).toBe(
      "REMOTE_COMMAND_FAILED",
    );
    capture.mockResolvedValueOnce({ exitCode: 1, output: "setup key is expired: secret-key" });
    expect(
      await executeRemoteMutation({ find, capture }, "netbird", ["up"], signal(), "secret-key"),
    ).toBe("REMOTE_AUTH_REJECTED");
  });
  it("does not claim success when NetBird reports ignored settings or a session owned by another user", async () => {
    const find = () => Promise.resolve("/fixture/netbird");
    for (const [output, reason] of [
      [
        "WARN the daemon did not apply the settings update: fixture-private",
        "REMOTE_SETTINGS_NOT_APPLIED",
      ],
      [
        "Already connected and the connection belongs to another user.",
        "REMOTE_PEER_IDENTITY_CONFLICT",
      ],
    ]) {
      const capture = vi.fn<typeof runCapture>(() =>
        Promise.resolve({ exitCode: 0, output: output! }),
      );
      expect(await executeRemoteMutation({ find, capture }, "netbird", ["up"], signal())).toBe(
        reason,
      );
    }
  });
});

describe.skipIf(process.platform !== "linux")("Linux credential descriptor integration", () => {
  it("reproduces the libuv stdin socket incompatibility without contacting a VPN", async () => {
    const result = await runCapture(
      process.execPath,
      [
        "-e",
        `try { require('node:fs').readFileSync('/dev/stdin'); process.exit(2); } catch (error) { process.stdout.write(error.code); }`,
      ],
      { timeoutMs: 5_000, input: "fixture-key\n" },
    );
    expect(result).toEqual({ exitCode: 0, output: "ENXIO" });
  });
  it("lets an actual child reopen a sealed anonymous RAM descriptor without persisting a key", async () => {
    const python = await findExecutable("python3");
    expect(python).not.toBeNull();
    const directory = await mkdtemp(join(tmpdir(), "everyos-vpn-fd-"));
    const executable = join(directory, "netbird");
    try {
      await writeFile(
        executable,
        `#!${process.execPath}
const fs = require('node:fs'), assert = require('node:assert/strict');
assert.equal(fs.readFileSync('/dev/stdin', 'utf8'), 'k'.repeat(4096) + '\\n');
assert.equal(fs.fstatSync(0).isFile(), true);
assert.equal(fs.fstatSync(0).nlink, 0);
assert.equal(fs.fstatSync(0).mode & 0o777, 0o600);
assert(fs.readlinkSync('/proc/self/fd/0').includes('memfd:everyos-vpn-credential'));
assert.throws(() => fs.writeSync(0, 'changed'), { code: 'EPERM' });
assert(!process.argv.join(' ').includes('k'.repeat(4096)));
process.stdout.write('sealed credential read');
`,
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      const capture = vi.fn<typeof runCapture>(runCapture);
      const result = await executeRemoteMutation(
        { find: (name) => Promise.resolve(name === "python3" ? python : executable), capture },
        "netbird",
        ["up", "--setup-key-file", "/dev/stdin"],
        signal(),
        "k".repeat(4096),
      );
      expect(result).toBeNull();
      expect(capture.mock.results).toHaveLength(1);
      expect(await capture.mock.results[0]!.value).toEqual({
        exitCode: 0,
        output: "sealed credential read",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
