/*
 * Zod-free update manager contracts (docs/updates.md). EveryOS never upgrades
 * the operating system on its own: every refresh and upgrade is started by an
 * administrator.
 */

export interface PackageInfo {
  name: string;
  installedVersion: string | null;
  candidateVersion: string | null;
  /** The candidate comes from a security suite. */
  security: boolean;
  section: string | null;
  /** Installed size of the candidate, bytes. */
  installedSize: number | null;
  summary: string | null;
  description: string | null;
  homepage: string | null;
  maintainer: string | null;
  /** Repositories offering the candidate, e.g. "noble-security/main". */
  origins: string[];
}

export const UPDATE_JOB_ACTIONS = ["refresh", "upgrade"] as const;

export type UpdateJobAction = (typeof UPDATE_JOB_ACTIONS)[number];

export interface UpdateJobView {
  id: string;
  action: UpdateJobAction;
  /** Upgrade: the selected packages; null upgrades everything that is upgradable. */
  packages: string[] | null;
  status: "running" | "succeeded" | "failed" | "interrupted";
  username: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Packages upgraded, from apt's summary line. */
  upgraded: number | null;
  error: string | null;
  /** The end of apt's output (bounded). */
  output: string;
}
