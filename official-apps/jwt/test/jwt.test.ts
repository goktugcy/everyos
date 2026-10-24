import { exportJWK, exportSPKI, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { describe, expect, it } from "vitest";
import { decode, redact, validity, verify } from "../src/jwt.ts";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const seconds = (ms: number) => Math.floor(ms / 1000);

async function signed(alg: string, claims: Record<string, unknown> = { sub: "ada" }) {
  if (alg.startsWith("HS")) {
    const secret = new TextEncoder().encode("correct horse battery staple, long enough");
    const token = await new SignJWT(claims).setProtectedHeader({ alg }).sign(secret);
    return { token, secret: "correct horse battery staple, long enough" };
  }
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const token = await new SignJWT(claims).setProtectedHeader({ alg, kid: "k1" }).sign(privateKey);
  return { token, pem: await exportSPKI(publicKey), jwk: await exportJWK(publicKey) };
}

describe("decoding", () => {
  it("reads header and payload, with or without Bearer", async () => {
    const { token } = await signed("HS256", {
      sub: "ada",
      name: "Ada Lovelace",
      exp: seconds(NOW) + 3600,
    });
    const result = decode(`Bearer ${token}`);
    expect(result.ok && result.token.header).toEqual({ alg: "HS256" });
    expect(result.ok && result.token.payload).toMatchObject({ sub: "ada", name: "Ada Lovelace" });
  });

  it("explains broken tokens", () => {
    expect(decode("")).toEqual({ ok: false, problem: "empty" });
    expect(decode("a.b")).toEqual({ ok: false, problem: "segments" });
    expect(decode("a.b.c.d.e")).toEqual({ ok: false, problem: "jwe" });
    expect(decode("!!!.e30.x")).toMatchObject({ ok: false, problem: "base64", part: 0 });
    expect(decode("bm90IGpzb24.e30.x")).toMatchObject({ ok: false, problem: "json", part: 0 });
    expect(decode("WzFd.e30.x")).toMatchObject({ ok: false, problem: "not-object", part: 0 });
    expect(decode("eyJhbGciOiJIUzI1NiJ9.e30.a+b")).toMatchObject({
      ok: false,
      problem: "base64",
      part: 2,
    });
  });

  it("keeps a non-JSON payload as text", () => {
    const result = decode("eyJhbGciOiJIUzI1NiJ9.aGVsbG8.sig");
    expect(result.ok && result.token.payload).toBeNull();
    expect(result.ok && result.token.payloadText).toBe("hello");
  });
});

describe("claims", () => {
  it("tells valid, expired and not-yet-valid apart, with clock tolerance", () => {
    const now = seconds(NOW);
    expect(validity({ exp: now + 60 }, NOW)).toEqual({ state: "valid", expiresIn: 60 });
    expect(validity({ exp: now - 10 }, NOW)).toEqual({ state: "expired", ago: 10 });
    expect(validity({ exp: now - 10 }, NOW, 30).state).toBe("valid");
    expect(validity({ nbf: now + 100, exp: now + 200 }, NOW)).toEqual({
      state: "not-yet",
      in: 100,
    });
    expect(validity({ sub: "x" }, NOW)).toEqual({ state: "no-expiry" });
  });

  it("redacts chosen claims", () => {
    expect(
      redact({ sub: "ada", email: "a@b.c", role: "admin" }, new Set(["sub", "email"])),
    ).toEqual({
      sub: "[redacted]",
      email: "[redacted]",
      role: "admin",
    });
  });
});

describe("signature verification", () => {
  it("verifies HMAC with text and base64 secrets", async () => {
    const { token, secret } = await signed("HS256");
    expect(await verify(token, secret!)).toBe("valid");
    expect(await verify(token, "wrong secret")).toBe("invalid-signature");
    expect(await verify(token, btoa(secret!), "base64")).toBe("valid");
    expect(await verify(token, "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")).toBe(
      "key-mismatch",
    );
  });

  for (const alg of ["RS256", "PS384", "ES256", "EdDSA"])
    it(`verifies ${alg} with PEM, JWK and JWK sets`, async () => {
      const { token, pem, jwk } = await signed(alg);
      expect(await verify(token, pem!)).toBe("valid");
      expect(await verify(token, JSON.stringify(jwk))).toBe("valid");
      expect(await verify(token, JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] }))).toBe("valid");
      expect(await verify(token, JSON.stringify({ keys: [{ ...jwk, kid: "other" }] }))).toBe(
        "no-matching-key",
      );
      const other = await signed(alg);
      expect(await verify(token, other.pem!)).toBe("invalid-signature");
    });

  it("refuses unsigned tokens, private keys and keys of the wrong type", async () => {
    const unsigned = new UnsecuredJWT({ sub: "x" }).encode();
    expect(await verify(unsigned, "anything")).toBe("alg-none");
    const rsa = await signed("RS256");
    const ec = await signed("ES256");
    expect(await verify(rsa.token, ec.pem!)).toBe("key-mismatch");
    expect(
      await verify(rsa.token, "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----"),
    ).toBe("private-key");
    expect(await verify(rsa.token, JSON.stringify({ ...rsa.jwk, d: "secret" }))).toBe(
      "private-key",
    );
    expect(await verify(rsa.token, "{not json")).toBe("bad-key");
  });
});
