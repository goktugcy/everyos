import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("generates an owner-reviewed production config only with a non-placeholder id and never overwrites it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "everyos-community-config-"));
  try {
    await mkdir(join(dir, "scripts"));
    await symlink(join(import.meta.dirname, "../node_modules"), join(dir, "node_modules"), "dir");
    const script = join(dir, "scripts/configure.ts");
    await copyFile(join(import.meta.dirname, "../scripts/configure.ts"), script);
    await copyFile(join(import.meta.dirname, "../wrangler.jsonc"), join(dir, "wrangler.jsonc"));
    const run = promisify(execFile);
    await expect(
      run(process.execPath, [
        script,
        "--database-id",
        "00000000-0000-0000-0000-000000000000",
        "--bucket",
        "test-community",
      ]),
    ).rejects.toThrow("real --database-id");
    const args = [
      script,
      "--database-id",
      "11111111-1111-4111-8111-111111111111",
      "--bucket",
      "test-community",
    ];
    await run(process.execPath, args);
    const config = JSON.parse(await readFile(join(dir, "wrangler.production.jsonc"), "utf8"));
    expect(config.vars).toEqual({
      PUBLIC_ORIGIN: "https://registry.everyos.net",
      ENVIRONMENT: "production",
    });
    expect(config.routes).toEqual([
      { pattern: "registry.everyos.net", custom_domain: true },
      { pattern: "everyos.goktugceyhan.dev", custom_domain: true },
    ]);
    expect(config.d1_databases[0].database_id).toBe(args[2]);
    expect(config.d1_databases[0].remote).toBeUndefined();
    expect(config.r2_buckets[0].bucket_name).toBe("test-community");
    expect(JSON.stringify(config)).not.toContain("BEGIN PRIVATE KEY");
    await expect(run(process.execPath, args)).rejects.toThrow("EEXIST");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
