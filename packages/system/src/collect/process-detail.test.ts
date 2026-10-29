import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessDetailSchema } from "@everyos/shared/schemas";
import { collectProcessDetail, processSupervisor } from "./process-detail.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("process supervision", () => {
  it("recognizes host services but never maps user sessions or containers to host runtime control", () => {
    expect(processSupervisor("0::/system.slice/nginx.service\n")).toEqual({
      serviceUnit: "nginx.service",
      containerId: null,
    });
    expect(
      processSupervisor("0::/user.slice/user-1000.slice/user@1000.service/app.slice/tool.service"),
    ).toEqual({ serviceUnit: null, containerId: null });
    const id = "a".repeat(64);
    for (const path of [
      `/system.slice/docker-${id}.scope`,
      `/system.slice/docker.service/docker/${id}`,
      `/docker/${id}`,
    ])
      expect(processSupervisor(`0::${path}`)).toEqual({ serviceUnit: null, containerId: id });
    expect(processSupervisor("0::/system.slice/../bad.service").serviceUnit).toBeNull();
  });
});

describe("collectProcessDetail", () => {
  it("reads one Linux process with measured metadata, links and supervisor identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "everyos-process-"));
    roots.push(root);
    mkdirSync(join(root, "proc/42"), { recursive: true });
    mkdirSync(join(root, "etc"));
    const fields = Array<string>(24).fill("0");
    fields[0] = "S";
    fields[11] = "50";
    fields[12] = "5";
    fields[17] = "3";
    fields[19] = "250";
    writeFileSync(join(root, "proc/42/stat"), `42 (nginx) ${fields.join(" ")}`);
    writeFileSync(join(root, "proc/stat"), "cpu  1 2 3 4 5 6 7 8\nbtime 1700000000\n");
    writeFileSync(join(root, "etc/passwd"), "www:x:1000:1000::/var/www:/bin/false\n");
    writeFileSync(
      join(root, "proc/42/status"),
      "Uid:\t1000 1000 1000 1000\nPPid:\t1\nVmRSS:\t100 kB\nVmSize:\t200 kB\n",
    );
    writeFileSync(join(root, "proc/42/cmdline"), "nginx\0--token=secret\0");
    writeFileSync(join(root, "proc/42/cgroup"), "0::/system.slice/nginx.service\n");
    symlinkSync("/usr/sbin/nginx", join(root, "proc/42/exe"));
    symlinkSync("/var/www", join(root, "proc/42/cwd"));
    const detail = await collectProcessDetail(42, {
      paths: { root, platform: "linux" },
      now: () => 1_700_000_010_000,
    });
    expect(ProcessDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      pid: 42,
      parentPid: 1,
      name: "nginx",
      user: "www",
      memoryBytes: 102400,
      virtualMemoryBytes: 204800,
      threads: 3,
      cpuPercent: 0,
      startedAt: 1_700_000_002_500,
      executable: "/usr/sbin/nginx",
      workingDirectory: "/var/www",
      serviceUnit: "nginx.service",
    });
    expect(await collectProcessDetail(999, { paths: { root, platform: "linux" } })).toBeNull();
    expect(await collectProcessDetail(-1)).toBeNull();
  });
});
