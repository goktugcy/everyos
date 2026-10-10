import type { HardwareStatus } from "@otuken/shared";
import { access, constants } from "node:fs/promises";
import { CommandError, findExecutable, runCommand } from "../exec.ts";
import { listDirOrEmpty, readTextOrNull } from "../fs-utils.ts";
import { hostPath, REAL_HOST, type HostPaths } from "../host-paths.ts";
import { parseSmartctl, parseThrottled } from "../linux/hardware.ts";

/** Finds the firmware `get_throttled` sysfs node (its parent differs between Pi models). */
async function findThrottledNode(paths: HostPaths): Promise<string | null> {
  const base = hostPath(paths, "/sys/devices/platform");
  for (const entry of await listDirOrEmpty(base)) {
    if (entry.includes("firmware")) {
      const direct = `${base}/${entry}/get_throttled`;
      if ((await readTextOrNull(direct, 64)) !== null) return direct;
    }
    if (!entry.startsWith("soc") && !entry.startsWith("axi")) continue;
    for (const child of await listDirOrEmpty(`${base}/${entry}`)) {
      if (!child.includes("firmware")) continue;
      const node = `${base}/${entry}/${child}/get_throttled`;
      if ((await readTextOrNull(node, 64)) !== null) return node;
    }
  }
  return null;
}

async function throttling(
  paths: HostPaths,
  isRaspberryPi: boolean,
): Promise<HardwareStatus["throttling"]> {
  if (paths.platform !== "linux")
    return { status: { available: false, reason: "not-linux" }, flags: null, raw: null };
  if (!isRaspberryPi)
    return { status: { available: false, reason: "unsupported-hardware" }, flags: null, raw: null };
  const node = await findThrottledNode(paths);
  let text = node ? await readTextOrNull(node, 64) : null;
  let reason: "tool-missing" | "permission-denied" | "not-detected" = "not-detected";
  if (text === null && paths.root === "/") {
    // Kernels without the firmware sysfs node (e.g. Ubuntu's raspi kernel) need
    // vcgencmd, which talks to the firmware through root-only /dev/vcio.
    const vcgencmd = await findExecutable("vcgencmd");
    if (!vcgencmd) reason = "tool-missing";
    else {
      try {
        text = await runCommand(vcgencmd, ["get_throttled"], { timeoutMs: 3_000 });
      } catch {
        text = null;
        const deviceAccessible = await access("/dev/vcio", constants.R_OK | constants.W_OK).then(
          () => true,
          () => false,
        );
        reason = deviceAccessible ? "not-detected" : "permission-denied";
      }
    }
  }
  const parsed = text ? parseThrottled(text) : null;
  return parsed
    ? { status: { available: true }, flags: parsed.flags, raw: parsed.raw }
    : { status: { available: false, reason }, flags: null, raw: null };
}

const SMARTCTL_OK_CODES = Array.from({ length: 256 }, (_, code) => code).filter(
  (code) => (code & 0b11) === 0,
);

async function nvme(paths: HostPaths): Promise<HardwareStatus["nvme"]> {
  if (paths.platform !== "linux")
    return { status: { available: false, reason: "not-linux" }, devices: [] };
  const controllers = (await listDirOrEmpty(hostPath(paths, "/sys/class/nvme"))).filter((name) =>
    /^nvme\d+$/.test(name),
  );
  if (controllers.length === 0)
    return { status: { available: false, reason: "not-detected" }, devices: [] };
  const smartctl = paths.root === "/" ? await findExecutable("smartctl") : null;
  if (!smartctl) return { status: { available: false, reason: "tool-missing" }, devices: [] };
  const devices: HardwareStatus["nvme"]["devices"] = [];
  let denied = false;
  for (const controller of controllers.slice(0, 16)) {
    const device = `/dev/${controller}`;
    try {
      // smartctl exit codes are a bit mask: bits 0–1 are fatal, higher bits report
      // health findings and still come with valid JSON.
      const output = await runCommand(smartctl, ["--json", "-a", device], {
        timeoutMs: 10_000,
        okExitCodes: SMARTCTL_OK_CODES,
      });
      const parsed = parseSmartctl(JSON.parse(output), device);
      if (parsed) devices.push(parsed);
    } catch (error) {
      // Bit 1: the device could not be opened (typically missing privileges).
      if (error instanceof CommandError && error.exitCode !== null && (error.exitCode & 0b10) !== 0)
        denied = true;
    }
  }
  if (devices.length === 0)
    return {
      status: { available: false, reason: denied ? "permission-denied" : "not-detected" },
      devices,
    };
  return { status: { available: true }, devices };
}

/** Raspberry Pi throttling/under-voltage state and NVMe health, when the host provides them. */
export async function collectHardware(options: {
  paths?: HostPaths;
  isRaspberryPi: boolean;
}): Promise<HardwareStatus> {
  const paths = options.paths ?? REAL_HOST;
  const [throttle, drives] = await Promise.all([
    throttling(paths, options.isRaspberryPi),
    nvme(paths),
  ]);
  return { source: "host", throttling: throttle, nvme: drives };
}
