import type { SshKey, SshKeyType } from "@everyos/app-sdk";

export type Editor = {
  kind: "generate" | "import" | "edit";
  id: string | null;
  name: string;
  comment: string;
  type: SshKeyType;
  publicKey: string;
};
export const emptyEditor = (kind: Editor["kind"]): Editor => ({
  kind,
  id: null,
  name: "",
  comment: "",
  type: "ed25519",
  publicKey: "",
});
export type FieldError = "name" | "comment" | "publicKey" | "passphrase" | "mismatch";
const oneLine = (value: string) =>
  !value.includes("\0") && !value.includes("\r") && !value.includes("\n");
const PUBLIC = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);
export const isPrivateInput = (value: string) =>
  /^\s*-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(value);
export function validateEditor(value: Editor): FieldError | null {
  if (!value.name.trim() || value.name.trim().length > 80 || !oneLine(value.name)) return "name";
  if (value.comment.trim().length > 200 || !oneLine(value.comment)) return "comment";
  if (value.kind === "import") {
    const key = value.publicKey.trim();
    const [type = "", data = ""] = key.split(/\s+/);
    if (
      key.length < 16 ||
      key.length > 16384 ||
      !oneLine(key) ||
      !PUBLIC.has(type) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    )
      return "publicKey";
  }
  return null;
}
export function validatePassphrase(value: string, repeated: string): FieldError | null {
  if (value.length < 8 || new TextEncoder().encode(value).byteLength > 1023 || !oneLine(value))
    return "passphrase";
  return value === repeated ? null : "mismatch";
}
export function visibleKeys(keys: readonly SshKey[], search: string, filter: string): SshKey[] {
  const query = search.trim().toLocaleLowerCase();
  return keys
    .filter(
      (key) =>
        (filter === "private"
          ? key.hasPrivateKey
          : filter === "public"
            ? !key.hasPrivateKey
            : true) &&
        [key.name, key.comment, key.type, key.fingerprint].some((value) =>
          value.toLocaleLowerCase().includes(query),
        ),
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}
