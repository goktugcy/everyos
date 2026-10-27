import { describe, expect, it } from "vitest";
import { AppSshExportSchema } from "./schemas/desktop-apps.ts";

const input = { id: "0089c577-3f81-4ea4-bb27-9b2ecf5ac215", private: true };
describe("SSH export passphrase contract", () => {
  it("keeps an explicitly unencrypted export separate from a bounded protected export", () => {
    expect(AppSshExportSchema.parse(input).passphrase).toBeNull();
    for (const passphrase of [
      "eight-ok",
      "x".repeat(1023),
      "ş".repeat(511) + "x",
      "界".repeat(341),
      "😀".repeat(255) + "abc",
    ])
      expect(AppSshExportSchema.parse({ ...input, passphrase }).passphrase).toBe(passphrase);
  });
  it("rejects strings that OpenSSH would truncate or cannot receive through its environment", () => {
    for (const passphrase of [
      "short",
      "x".repeat(1024),
      "ş".repeat(512),
      "界".repeat(342),
      "😀".repeat(256),
      "dummy-secret\nrest",
      "dummy-secret\rrest",
      `dummy-secret${String.fromCharCode(0)}rest`,
    ]) {
      const result = AppSshExportSchema.safeParse({ ...input, passphrase });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(JSON.stringify(result.error.issues)).not.toContain("dummy-secret");
    }
  });
});
