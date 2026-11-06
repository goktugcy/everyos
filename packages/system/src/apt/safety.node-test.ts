import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { assertPackageMutationSafe, PackageEnvironmentError } from "./safety.ts";

const kernel = "6.8.0-fixture-generic";
const mount = "1 0 0:1 / / rw - tmpfs tmpfs rw\n";
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "everyos-package-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of [`usr/lib/modules/${kernel}`, "boot", "var/lib/dpkg", "proc/1", "proc/self"])
    await mkdir(join(root, name), { recursive: true });
  await symlink("usr/lib", join(root, "lib"));
  await symlink(root, join(root, "proc/1/root"));
  await writeFile(
    join(root, `usr/lib/modules/${kernel}/modules.dep`),
    "kernel/drivers/fixture.ko:\n",
  );
  await writeFile(join(root, "proc/self/mountinfo"), mount);
  return { root, options: { paths: { root, platform: "linux" as const }, kernel } };
}
void test("permits the real writable host tree, including a merged /usr, without modifying it", async (t) => {
  const { root, options } = await fixture(t);
  await assertPackageMutationSafe(options);
  assert.equal(
    await readFile(join(root, `lib/modules/${kernel}/modules.dep`), "utf8"),
    "kernel/drivers/fixture.ko:\n",
  );
});
void test("supports a non-merged module tree without requiring /usr/lib/modules", async (t) => {
  const { root, options } = await fixture(t);
  await rm(join(root, "lib"));
  await rename(join(root, "usr/lib"), join(root, "lib"));
  await assertPackageMutationSafe(options);
});
void test("rejects a masked module directory even if it is present and readable", async (t) => {
  const { root, options } = await fixture(t);
  const reference = await mkdtemp(join(tmpdir(), "everyos-host-reference-"));
  t.after(() => rm(reference, { recursive: true, force: true }));
  await mkdir(join(reference, "lib/modules"), { recursive: true });
  await rm(join(root, "proc/1/root"));
  await symlink(reference, join(root, "proc/1/root"));
  await assert.rejects(assertPackageMutationSafe(options), PackageEnvironmentError);
});
for (const point of ["/usr", "/boot", "/var/lib/dpkg", `/usr/lib/modules/${kernel}`]) {
  void test(`rejects read-only package/boot mounts at ${point}`, async (t) => {
    const { root, options } = await fixture(t);
    await writeFile(
      join(root, "proc/self/mountinfo"),
      mount + `2 1 0:2 / ${point} ro - tmpfs tmpfs rw\n`,
    );
    await assert.rejects(assertPackageMutationSafe(options), PackageEnvironmentError);
  });
}
void test("allows unrelated read-only kernel-tunable mounts", async (t) => {
  const { root, options } = await fixture(t);
  await writeFile(
    join(root, "proc/self/mountinfo"),
    mount + "2 1 0:2 / /sys ro - sysfs sysfs ro\n",
  );
  await assertPackageMutationSafe(options);
});
void test("refuses missing module metadata rather than treating an empty tree as safe", async (t) => {
  const { root, options } = await fixture(t);
  await rm(join(root, `usr/lib/modules/${kernel}/modules.dep`));
  await assert.rejects(assertPackageMutationSafe(options), PackageEnvironmentError);
});
void test("refuses unavailable host references and malformed mount information", async (t) => {
  const { root, options } = await fixture(t);
  await writeFile(join(root, "proc/self/mountinfo"), "not a mount table\n");
  await assert.rejects(assertPackageMutationSafe(options), PackageEnvironmentError);
  await writeFile(join(root, "proc/self/mountinfo"), mount);
  await rm(join(root, "proc/1/root"));
  await assert.rejects(assertPackageMutationSafe(options), PackageEnvironmentError);
});
void test("never enables mutations on an unsupported platform", async () => {
  await assert.rejects(
    assertPackageMutationSafe({ paths: { root: "/unused", platform: "darwin" } }),
    PackageEnvironmentError,
  );
});
