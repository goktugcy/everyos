import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verifyRelease } from "./manifest.ts";

it("publishes a self-contained, syntax-valid bootstrap signed with the manifest publisher key", () => {
  const directory = mkdtempSync(join(tmpdir(), "everyos-bootstrap-test-"));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  try {
    const keyFile = join(directory, "test-private.pem");
    writeFileSync(keyFile, keys.privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
    });
    // These bytes only exercise the signer; this isolated test never installs a package.
    for (const arch of ["arm64", "amd64"])
      writeFileSync(join(directory, `everyos_0.1.0_${arch}.deb`), `test package: ${arch}`);
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../../../scripts/sign-release.ts", import.meta.url)),
      "--version",
      "0.1.0",
      "--key-file",
      keyFile,
      "--directory",
      directory,
    ]);
    const bootstrap = readFileSync(join(directory, "install.sh"));
    const signature = readFileSync(join(directory, "install.sh.sig"));
    expect(readFileSync(join(directory, "everyos-release-public.pem"), "utf8")).toBe(publicKey);
    expect(verify(null, bootstrap, publicKey, signature)).toBe(true);
    expect(
      verify(null, Buffer.concat([bootstrap, Buffer.from("\n# changed\n")]), publicKey, signature),
    ).toBe(false);
    const installer = readFileSync(
      new URL("../../../packaging/install.py", import.meta.url),
      "utf8",
    );
    expect(bootstrap.toString()).toContain(`\n${installer.trimEnd()}\nEVERYOS_PYTHON_INSTALLER\n`);
    expect(bootstrap.toString()).toContain(`\n${publicKey.trimEnd()}\nEVERYOS_PUBLISHER_KEY\n`);
    expect(bootstrap.toString()).not.toContain("@@EVERYOS_");
    execFileSync("bash", ["-n"], { input: bootstrap });
    const manifest = verifyRelease(
      readFileSync(join(directory, "release.json"), "utf8"),
      publicKey,
    );
    expect(manifest.artifacts.arm64.sha256).toBe(
      createHash("sha256").update("test package: arm64").digest("hex"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
