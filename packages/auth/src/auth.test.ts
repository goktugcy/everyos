import { PASSWORD_MIN_LENGTH } from "@otuken/shared";
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  checkPasswordPolicy,
  createDummyVerifier,
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  hotp,
  verifyPassword,
  verifyTotp,
  type ScryptParams,
} from "./index.ts";

// Cheap parameters keep the suite fast; production defaults are covered by one test.
const FAST: ScryptParams = { log2N: 10, r: 8, p: 1 };

describe("password hashing", () => {
  it("verifies the correct password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery", FAST);
    expect(hash).toMatch(/^\$scrypt\$v=1\$ln=10,r=8,p=1\$[\w-]+\$[\w-]+$/);
    expect((await verifyPassword("correct horse battery", hash, FAST)).valid).toBe(true);
    expect((await verifyPassword("correct horse batterY", hash, FAST)).valid).toBe(false);
  });

  it("uses a unique salt per hash", async () => {
    expect(await hashPassword("same-password", FAST)).not.toBe(
      await hashPassword("same-password", FAST),
    );
  });

  it("normalizes Unicode so equivalent input verifies", async () => {
    // "ş" precomposed (U+015F) vs. "s" + combining cedilla (U+0073 U+0327).
    const hash = await hashPassword("parolaşifre", FAST);
    expect((await verifyPassword("parolaşifre", hash, FAST)).valid).toBe(true);
  });

  it("flags hashes created with weaker parameters for rehashing", async () => {
    const hash = await hashPassword("rehash-me-please", FAST);
    const result = await verifyPassword("rehash-me-please", hash, { log2N: 11, r: 8, p: 1 });
    expect(result).toEqual({ valid: true, needsRehash: true });
  });

  it("rejects malformed or unsupported hashes without throwing", async () => {
    for (const bad of [
      "",
      "plain",
      "$scrypt$v=1$ln=40,r=8,p=1$c2FsdA$aGFzaA",
      "$argon2id$v=19$m=1$x$y",
    ]) {
      expect(await verifyPassword("x", bad, FAST)).toEqual({ valid: false, needsRehash: false });
    }
  });

  it("works with production default parameters", async () => {
    const hash = await hashPassword("production-default-check");
    expect(hash).toContain("ln=16,r=8,p=2");
    expect((await verifyPassword("production-default-check", hash)).valid).toBe(true);
  });

  it("dummy verifier completes without throwing", async () => {
    await expect(createDummyVerifier(FAST)()).resolves.toBeUndefined();
  });
});

describe("password policy", () => {
  it("accepts a reasonable password", () => {
    expect(checkPasswordPolicy("mavi-dag-gokyuzu-42", { username: "goktug" })).toEqual([]);
  });

  it("reports each violation", () => {
    expect(checkPasswordPolicy("short")).toContain("too-short");
    expect(checkPasswordPolicy("x".repeat(300))).toContain("too-long");
    expect(checkPasswordPolicy("admin-goktug-2026", { username: "goktug" })).toContain(
      "contains-username",
    );
    expect(checkPasswordPolicy("Password123")).toContain("too-common");
    expect(checkPasswordPolicy("ababababababab")).toContain("repetitive");
  });

  it("matches the shared minimum length", () => {
    expect(checkPasswordPolicy("a1b2c3d4e5".slice(0, PASSWORD_MIN_LENGTH - 1))).toContain(
      "too-short",
    );
    expect(checkPasswordPolicy("a1b2c3d4e5f6".slice(0, PASSWORD_MIN_LENGTH))).not.toContain(
      "too-short",
    );
  });
});

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const data = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 17]);
    expect(base32Decode(base32Encode(data)).equals(data)).toBe(true);
  });

  it("matches RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
  });
});

describe("TOTP", () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890".
  const rfcSecret = base32Encode(Buffer.from("12345678901234567890"));
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  it.each(vectors)("matches RFC 6238 vector at T=%i", (seconds, expected) => {
    expect(generateTotp(rfcSecret, seconds * 1000, { digits: 8 })).toBe(expected);
  });

  it("matches RFC 4226 HOTP vectors", () => {
    const secret = Buffer.from("12345678901234567890");
    expect(hotp(secret, 0)).toBe("755224");
    expect(hotp(secret, 9)).toBe("520489");
  });

  it("accepts codes within the skew window and rejects others", () => {
    const secret = generateTotpSecret();
    const now = 1_760_000_000_000;
    expect(verifyTotp(secret, generateTotp(secret, now), now)).not.toBeNull();
    expect(verifyTotp(secret, generateTotp(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, generateTotp(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now)).toBeNull();
  });

  it("prevents replay of an already used step", () => {
    const secret = generateTotpSecret();
    const now = 1_760_000_000_000;
    const code = generateTotp(secret, now);
    const step = verifyTotp(secret, code, now);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, now, { lastUsedStep: step })).toBeNull();
  });

  it("builds an otpauth URI understood by authenticator apps", () => {
    const uri = buildOtpauthUri({
      secret: "JBSWY3DPEHPK3PXP",
      accountName: "goktug@pi5",
      issuer: "Otuken",
    });
    expect(uri).toBe(
      "otpauth://totp/Otuken:goktug%40pi5?secret=JBSWY3DPEHPK3PXP&issuer=Otuken&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("recovery codes", () => {
  it("generates unique, readable codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  });

  it("hashes codes independent of case and separators", () => {
    expect(hashRecoveryCode("ABCDE-FGHJK")).toBe(hashRecoveryCode(" abcde fghjk "));
    expect(hashRecoveryCode("abcde-fghjk")).not.toBe(hashRecoveryCode("abcde-fghjm"));
  });
});
