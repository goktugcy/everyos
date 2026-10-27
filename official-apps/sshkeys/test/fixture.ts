import type { SshKey } from "@everyos/app-sdk";

export const key = (patch: Partial<SshKey> = {}): SshKey => ({
  id: "key-1",
  name: "Laptop",
  type: "ssh-ed25519",
  bits: 256,
  comment: "Home access",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE1vY2tQdWJsaWNLZXlGb3JJbnRlcmZhY2VUZXN0 laptop",
  fingerprint: "SHA256:interface-test-fingerprint",
  hasPrivateKey: true,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  ...patch,
});
