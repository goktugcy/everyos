/** Parses the freedesktop os-release format (KEY=value, optionally quoted). */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    let value = line.slice(eq + 1);
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["\\`$])/g, "$1");
    }
    out[key] = value;
  }
  return out;
}

/** Device-tree strings are NUL-terminated. */
export function cleanDeviceTreeString(text: string): string {
  return text.replace(/\0+$/g, "").replaceAll("\0", " ").trim();
}

// ARM "CPU part" identifiers (implementer 0x41, Arm Ltd.) for common SoCs.
const ARM_CPU_PARTS: Record<string, string> = {
  "0xd03": "Cortex-A53",
  "0xd04": "Cortex-A35",
  "0xd05": "Cortex-A55",
  "0xd07": "Cortex-A57",
  "0xd08": "Cortex-A72",
  "0xd09": "Cortex-A73",
  "0xd0a": "Cortex-A75",
  "0xd0b": "Cortex-A76",
  "0xd0c": "Neoverse-N1",
  "0xd0d": "Cortex-A77",
  "0xd40": "Neoverse-V1",
  "0xd41": "Cortex-A78",
  "0xd44": "Cortex-X1",
  "0xd46": "Cortex-A510",
  "0xd47": "Cortex-A710",
  "0xd49": "Neoverse-N2",
  "0xd4f": "Neoverse-V2",
};

/**
 * Extracts a human-readable CPU model from /proc/cpuinfo. x86 exposes
 * "model name"; many ARM kernels only expose implementer/part numbers.
 */
export function cpuModelFromCpuinfo(text: string): string | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    if (!fields.has(key)) fields.set(key, line.slice(idx + 1).trim());
  }
  const modelName = fields.get("model name");
  if (modelName && !/^ARMv\d/i.test(modelName)) return modelName;
  const implementer = fields.get("cpu implementer");
  const part = fields.get("cpu part")?.toLowerCase();
  if (implementer === "0x41" && part && ARM_CPU_PARTS[part]) return `ARM ${ARM_CPU_PARTS[part]}`;
  return modelName ?? fields.get("hardware") ?? null;
}
