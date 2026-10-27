import { describe, expect, it } from "vitest";
import {
  emptyEditor,
  isPrivateInput,
  validateEditor,
  validatePassphrase,
  visibleKeys,
} from "../src/keys.ts";
import { key } from "./fixture.ts";

describe("SSH key forms", () => {
  it("validates single-line metadata without changing public key material", () => {
    const editor = { ...emptyEditor("generate"), name: " Laptop ", comment: "Home" };
    expect(validateEditor(editor)).toBeNull();
    for (const name of [" ", "a".repeat(81), "name\nother", "name\r", "name\0"])
      expect(validateEditor({ ...editor, name })).toBe("name");
    for (const comment of ["a".repeat(201), "line\nother", "line\r", "line\0"])
      expect(validateEditor({ ...editor, comment })).toBe("comment");
    expect(
      validateEditor({ ...editor, name: "a".repeat(80), comment: "b".repeat(200) }),
    ).toBeNull();
  });
  it("accepts one supported public-key line and rejects private key headers and extra lines", () => {
    const editor = { ...emptyEditor("import"), name: "Public", publicKey: key().publicKey };
    expect(validateEditor(editor)).toBeNull();
    for (const publicKey of [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret",
      "ssh-dss AAAABBBB",
      "ssh-ed25519 !invalid!",
      `${key().publicKey}\n${key().publicKey}`,
      `ssh-ed25519 ${"A".repeat(16384)}`,
    ])
      expect(validateEditor({ ...editor, publicKey })).toBe("publicKey");
    for (const header of ["OPENSSH", "RSA", "EC", "ENCRYPTED"])
      expect(isPrivateInput(`  -----BEGIN ${header} PRIVATE KEY-----\nsecret`)).toBe(true);
    expect(isPrivateInput(key().publicKey)).toBe(false);
  });
  it("checks OpenSSH UTF-8 passphrase limits and matching without trimming spaces", () => {
    for (const value of ["short", "abcdefgh\n", "abcdefgh\r", "abcdefgh\0", "ü".repeat(512)])
      expect(validatePassphrase(value, value)).toBe("passphrase");
    const boundary = "ü".repeat(511) + "x";
    expect(validatePassphrase(boundary, boundary)).toBeNull();
    expect(validatePassphrase(" secret ", " secret ")).toBeNull();
    expect(validatePassphrase("abcdefgh", "abcdefgi")).toBe("mismatch");
  });
  it("filters public metadata and private availability, then orders most recently updated first", () => {
    const items = [
      key({ id: "old", name: "Laptop", updatedAt: 1 }),
      key({ id: "public", name: "Server", comment: "Work", hasPrivateKey: false, updatedAt: 3 }),
      key({ id: "new", name: "Backup", type: "ssh-rsa", updatedAt: 2 }),
    ];
    expect(visibleKeys(items, "", "all").map((item) => item.id)).toEqual(["public", "new", "old"]);
    expect(visibleKeys(items, " work ", "public").map((item) => item.id)).toEqual(["public"]);
    expect(visibleKeys(items, "ssh-rsa", "private").map((item) => item.id)).toEqual(["new"]);
    expect(visibleKeys(items, "SHA256:interface", "all")).toHaveLength(3);
    expect(items.map((item) => item.id)).toEqual(["old", "public", "new"]);
  });
});
