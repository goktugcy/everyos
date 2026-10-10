import { join } from "node:path";

/**
 * Filesystem roots used for host introspection. Production uses the real
 * roots; tests point them at fixture directories so parsing logic can be
 * verified against captured data from real devices (e.g. a Raspberry Pi 5).
 */
export interface HostPaths {
  root: string;
  platform: NodeJS.Platform;
}

export const REAL_HOST: HostPaths = { root: "/", platform: process.platform };

export function hostPath(paths: HostPaths, absolute: string): string {
  return paths.root === "/" ? absolute : join(paths.root, absolute);
}
