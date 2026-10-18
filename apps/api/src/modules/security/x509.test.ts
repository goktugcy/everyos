import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { connect, type ConnectionOptions, createServer } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  type CertificatePair,
  certificateFingerprint,
  createLocalCa,
  issueServerCertificate,
} from "./x509.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

const ca = createLocalCa({ commonName: "EveryOS Local CA", now: NOW });
const caCert = new X509Certificate(ca.certPem);

type IssueInput = Parameters<typeof issueServerCertificate>[0];

const issue = (overrides: Partial<IssueInput> = {}) =>
  issueServerCertificate({
    ca,
    commonName: "everyos.local",
    dnsNames: ["everyos.local", "localhost"],
    ipAddresses: ["192.168.1.20", "fd7a:115c:a1e0::1", "127.0.0.1"],
    now: NOW,
    ...overrides,
  });

/** RFC 5280 method 1 over a P-256 key: SHA-1 of the 65-byte uncompressed point. */
const keyId = (cert: X509Certificate) =>
  createHash("sha1")
    .update(cert.publicKey.export({ type: "spki", format: "der" }).subarray(-65))
    .digest();

describe("createLocalCa", () => {
  it("is a self-signed CA for EveryOS", () => {
    expect(caCert.ca).toBe(true);
    expect(caCert.subject).toContain("CN=EveryOS Local CA");
    expect(caCert.subject).toContain("O=EveryOS");
    expect(caCert.issuer).toBe(caCert.subject);
    expect(caCert.verify(caCert.publicKey)).toBe(true);
    expect(caCert.checkIssued(caCert)).toBe(true);
    expect(caCert.signatureAlgorithm).toBe("ecdsa-with-SHA256");
    expect(caCert.raw.includes(keyId(caCert))).toBe(true);
  });

  it("is valid from an hour before now for ten years by default", () => {
    expect(caCert.validFromDate.getTime()).toBe(NOW - HOUR);
    expect(caCert.validToDate.getTime()).toBe(NOW + 3650 * DAY);
  });

  it("switches to GeneralizedTime from 2050 on", () => {
    const now = Date.UTC(2045, 0, 1);
    const cert = new X509Certificate(
      createLocalCa({ commonName: "CA", now, validDays: 3650 }).certPem,
    );
    expect(cert.validFromDate.getTime()).toBe(now - HOUR);
    expect(cert.validToDate.getTime()).toBe(now + 3650 * DAY);
    expect(cert.validToDate.getUTCFullYear()).toBe(2054);
    expect(cert.raw.includes(Buffer.from("\x17\x0d441231230000Z", "latin1"))).toBe(true);
    expect(cert.raw.includes(Buffer.from("\x18\x0f20541230000000Z", "latin1"))).toBe(true);
  });

  it("writes PEM and a P-256 PKCS#8 key that belongs to the certificate", () => {
    expect(ca.certPem).toMatch(
      /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\n$/,
    );
    expect(ca.certPem.split("\n").every((line) => line.length <= 64)).toBe(true);
    expect(ca.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const key = createPrivateKey(ca.keyPem);
    expect(key.asymmetricKeyType).toBe("ec");
    expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(caCert.checkPrivateKey(key)).toBe(true);
  });

  it("uses random positive serial numbers", () => {
    const serial = BigInt(`0x${caCert.serialNumber}`);
    expect(serial > 0n && serial < 2n ** 127n).toBe(true);
    const next = new X509Certificate(createLocalCa({ commonName: "CA", now: NOW }).certPem);
    expect(next.serialNumber).not.toBe(caCert.serialNumber);
  });

  it("rejects a bad validity or common name", () => {
    expect(() => createLocalCa({ commonName: "CA", now: NOW, validDays: 0 })).toThrow(RangeError);
    expect(() => createLocalCa({ commonName: "", now: NOW })).toThrow();
    expect(() => createLocalCa({ commonName: "x".repeat(65), now: NOW })).toThrow();
  });
});

describe("issueServerCertificate", () => {
  const server = issue();
  const cert = new X509Certificate(server.certPem);

  it("is issued and signed by the CA", () => {
    expect(cert.checkIssued(caCert)).toBe(true);
    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(false);
    expect(cert.ca).toBe(false);
    expect(cert.issuer).toBe(caCert.subject);
    expect(cert.subject).toBe("CN=everyos.local");
    expect(cert.signatureAlgorithm).toBe("ecdsa-with-SHA256");
  });

  it("carries its own key identifier and the CA's", () => {
    expect(cert.raw.includes(keyId(cert))).toBe(true);
    expect(cert.raw.includes(keyId(caCert))).toBe(true);
    // Another CA with the very same name is not taken for the issuer.
    const impostor = new X509Certificate(
      createLocalCa({ commonName: "EveryOS Local CA", now: NOW }).certPem,
    );
    expect(impostor.subject).toBe(caCert.subject);
    expect(cert.checkIssued(impostor)).toBe(false);
    expect(cert.verify(impostor.publicKey)).toBe(false);
  });

  it("lists every DNS name and IP address", () => {
    expect(cert.subjectAltName).toBe(
      "DNS:everyos.local, DNS:localhost, IP Address:192.168.1.20, " +
        "IP Address:FD7A:115C:A1E0:0:0:0:0:1, IP Address:127.0.0.1",
    );
    expect(cert.checkHost("everyos.local")).toBe("everyos.local");
    expect(cert.checkHost("other.local")).toBeUndefined();
    expect(cert.checkIP("192.168.1.20")).toBe("192.168.1.20");
    expect(cert.checkIP("fd7a:115c:a1e0::1")).toBeDefined();
    expect(cert.checkIP("192.168.1.21")).toBeUndefined();
  });

  it("lowercases and deduplicates names and addresses", () => {
    const deduped = new X509Certificate(
      issue({
        dnsNames: ["EveryOS.Local", "everyos.local", "everyos.local."],
        ipAddresses: ["192.168.1.20", "192.168.1.20", "fd7a:115c:a1e0:0::1", "fd7a:115c:a1e0::1"],
      }).certPem,
    );
    expect(deduped.subjectAltName).toBe(
      "DNS:everyos.local, IP Address:192.168.1.20, IP Address:FD7A:115C:A1E0:0:0:0:0:1",
    );
    const mapped = new X509Certificate(
      issue({ dnsNames: [], ipAddresses: ["::ffff:10.0.0.1", "::"] }).certPem,
    );
    expect(mapped.subjectAltName).toBe(
      "IP Address:0:0:0:0:0:FFFF:A00:1, IP Address:0:0:0:0:0:0:0:0",
    );
  });

  it("is for TLS servers only", () => {
    expect(cert.keyUsage).toEqual([SERVER_AUTH]);
  });

  it("is valid for at most 397 days, from an hour before now", () => {
    expect(cert.validFromDate.getTime()).toBe(NOW - HOUR);
    expect(cert.validToDate.getTime() - cert.validFromDate.getTime()).toBe(397 * DAY);
    const short = new X509Certificate(issue({ validDays: 30 }).certPem);
    expect(short.validToDate.getTime() - short.validFromDate.getTime()).toBe(30 * DAY);
  });

  it("never outlives its CA", () => {
    const brief = createLocalCa({ commonName: "CA", now: NOW, validDays: 100 });
    const issued = new X509Certificate(issue({ ca: brief }).certPem);
    expect(issued.validToDate).toEqual(new X509Certificate(brief.certPem).validToDate);
    expect(() => issue({ ca: brief, now: NOW + 100 * DAY })).toThrow(/expired/);
  });

  it("rejects validities over 397 days", () => {
    expect(() => issue({ validDays: 398 })).toThrow(RangeError);
    expect(() => issue({ validDays: 0 })).toThrow(RangeError);
    expect(() => issue({ validDays: 1.5 })).toThrow(RangeError);
  });

  it("rejects invalid IP addresses and DNS names", () => {
    for (const address of ["300.1.1.1", "192.168.1", "fe80::1%en0", "fd7a::1::2", "everyos"])
      expect(() => issue({ ipAddresses: [address] }), address).toThrow(/IP address/);
    for (const host of [
      "",
      "bad_name.local",
      "-everyos.local",
      "everyos-.local",
      "a..b",
      "*.everyos.local",
      `${"x".repeat(64)}.local`,
      "ünicode.local",
      "192.168.1.20",
    ])
      expect(() => issue({ dnsNames: [host] }), host).toThrow(/DNS name/);
  });

  it("needs at least one name or address", () => {
    expect(() => issue({ dnsNames: [], ipAddresses: [] })).toThrow(/DNS name or IP address/);
  });

  it("only issues from a CA certificate with its own key", () => {
    const other = createLocalCa({ commonName: "CA", now: NOW });
    expect(() => issue({ ca: { certPem: ca.certPem, keyPem: other.keyPem } })).toThrow();
    expect(() => issue({ ca: server })).toThrow();
  });

  it("returns a private key that matches the certificate", () => {
    const key = createPrivateKey(server.keyPem);
    expect(cert.checkPrivateKey(key)).toBe(true);
    expect(createPublicKey(key).export({ type: "spki", format: "der" })).toEqual(
      cert.publicKey.export({ type: "spki", format: "der" }),
    );
    expect(cert.checkPrivateKey(createPrivateKey(issue().keyPem))).toBe(false);
  });
});

describe("TLS", () => {
  // Certificates valid at the real clock, for real handshakes.
  const liveCa = createLocalCa({ commonName: "EveryOS Local CA", now: Date.now() });
  const live = issue({ ca: liveCa, now: Date.now() });

  async function handshake(pair: CertificatePair, options: ConnectionOptions) {
    const listener = createServer({ cert: pair.certPem, key: pair.keyPem }, (socket) =>
      socket.end(),
    );
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    try {
      const { port } = listener.address() as AddressInfo;
      const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...options });
      await once(socket, "secureConnect");
      const result = {
        authorized: socket.authorized,
        error: socket.authorized ? null : String(socket.authorizationError),
      };
      socket.destroy();
      return result;
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }

  it("is trusted for a DNS name by a client that trusts the CA", async () => {
    expect(await handshake(live, { ca: liveCa.certPem, servername: "everyos.local" })).toEqual({
      authorized: true,
      error: null,
    });
  });

  it("is trusted for an IP address with the default identity check", async () => {
    expect(await handshake(live, { ca: liveCa.certPem })).toEqual({
      authorized: true,
      error: null,
    });
  });

  it("is not trusted without the CA or for another name", async () => {
    expect(await handshake(live, { servername: "everyos.local" })).toEqual({
      authorized: false,
      error: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    expect(await handshake(live, { ca: liveCa.certPem, servername: "other.local" })).toEqual({
      authorized: false,
      error: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });
});

describe("certificateFingerprint", () => {
  it("matches Node's SHA-256 fingerprint", () => {
    expect(certificateFingerprint(ca.certPem)).toBe(caCert.fingerprint256);
    const server = issue().certPem;
    expect(certificateFingerprint(server)).toBe(new X509Certificate(server).fingerprint256);
    expect(certificateFingerprint(server)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});
