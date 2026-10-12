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

export interface LinuxAccountStatus {
  account: LinuxAccount | null;
  privilegedUntil: number | null;
}
