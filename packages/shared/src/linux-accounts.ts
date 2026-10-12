/** Linux identities are pinned to the local account's numeric UID. */
export interface LinuxAccount {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export interface LinuxBinding {
  userId: string;
  account: string;
  uid: number;
}

export const LINUX_PRIVILEGE_DURATIONS = [
  "15m",
  "30m",
  "1h",
  "5h",
  "1d",
  "1w",
  "1mo",
  "permanent",
] as const;
export type LinuxPrivilegeDuration = (typeof LINUX_PRIVILEGE_DURATIONS)[number];
export const LINUX_PRIVILEGE_DURATION_MS: Readonly<Record<LinuxPrivilegeDuration, number | null>> =
  {
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "5h": 5 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
    "1w": 7 * 24 * 60 * 60_000,
    "1mo": 30 * 24 * 60 * 60_000,
    permanent: null,
  };

export interface LinuxAccountStatus {
  account: LinuxAccount | null;
  privileged: boolean;
  privilegedUntil: number | null;
  privilegeDuration: LinuxPrivilegeDuration | null;
  privilegeScope: "session" | "account" | null;
}
