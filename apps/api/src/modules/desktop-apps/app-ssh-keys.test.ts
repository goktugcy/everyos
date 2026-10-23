import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePublicKey } from "./app-ssh-keys.ts";

const field = (value: string | Buffer) => {
  const data = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
};
const line = (type: string, values: (string | Buffer)[], trailing = Buffer.alloc(0)) =>
  `${type} ${Buffer.concat([field(type), ...values.map(field), trailing]).toString("base64")} comment`;
const point = (curve: string) => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: curve });
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
};
const modulus = Buffer.alloc(256, 7);
modulus[0] = 0x80;
const positiveModulus = Buffer.concat([Buffer.from([0]), modulus]);

describe("SSH public wire validation", () => {
  it("reads Ed25519 and complete security-key public fields", () => {
    expect(parsePublicKey(line("ssh-ed25519", [Buffer.alloc(32, 1)]))).toMatchObject({
      type: "ssh-ed25519",
      bits: 256,
      comment: "comment",
    });
    expect(
      parsePublicKey(line("sk-ssh-ed25519@openssh.com", [Buffer.alloc(32, 1), "ssh:test"])),
    ).toMatchObject({ bits: 256 });
    expect(
      parsePublicKey(
        line("sk-ecdsa-sha2-nistp256@openssh.com", ["nistp256", point("P-256"), "ssh:test"]),
      ),
    ).toMatchObject({ bits: 256 });
  });
  it("validates all supported NIST public points against the curve named by their algorithm", () => {
    for (const bits of [256, 384, 521]) {
      const type = `ecdsa-sha2-nistp${bits}`;
      expect(parsePublicKey(line(type, [`nistp${bits}`, point(`P-${bits}`)]))).toMatchObject({
        type,
        bits,
      });
    }
    expect(() =>
      parsePublicKey(line("ecdsa-sha2-nistp256", ["nistp384", point("P-256")])),
    ).toThrow();
    expect(() =>
      parsePublicKey(
        line("ecdsa-sha2-nistp256", [
          "nistp256",
          Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]),
        ]),
      ),
    ).toThrow();
    expect(() =>
      parsePublicKey(line("ecdsa-sha2-nistp256", ["nistp256", Buffer.alloc(65, 2)])),
    ).toThrow();
  });
  it("requires exact field consumption and a NUL-free security-key application", () => {
    for (const input of [
      line("ssh-ed25519", [Buffer.alloc(31)]),
      line("ssh-ed25519", [Buffer.alloc(32)], Buffer.from([1])),
      line("sk-ssh-ed25519@openssh.com", [Buffer.alloc(32)]),
      line("sk-ssh-ed25519@openssh.com", [Buffer.alloc(32), Buffer.from([0])]),
      line("sk-ecdsa-sha2-nistp256@openssh.com", ["nistp256", point("P-256")]),
      line("ssh-ed25519", [Buffer.alloc(32)]) + String.fromCharCode(0),
    ])
      expect(() => parsePublicKey(input)).toThrow();
  });
  it("measures actual RSA bits and refuses negative, zero and noncanonical mpints", () => {
    expect(
      parsePublicKey(line("ssh-rsa", [Buffer.from([1, 0, 1]), positiveModulus])),
    ).toMatchObject({ type: "ssh-rsa", bits: 2048 });
    const tooSmall = Buffer.from(modulus);
    tooSmall[0] = 0x7f;
    for (const values of [
      [Buffer.alloc(0), positiveModulus],
      [Buffer.from([0]), positiveModulus],
      [Buffer.from([2]), positiveModulus],
      [Buffer.from([1, 0, 1]), modulus],
      [Buffer.from([1, 0, 1]), Buffer.concat([Buffer.from([0, 0]), modulus])],
      [Buffer.from([1, 0, 1]), tooSmall],
    ])
      expect(() => parsePublicKey(line("ssh-rsa", values))).toThrow();
  });
});
