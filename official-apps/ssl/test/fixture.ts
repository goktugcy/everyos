import type { NetTlsResult, TlsCertificate } from "@everyos/app-sdk";

export function certificate(changes: Partial<TlsCertificate> = {}): TlsCertificate {
  return {
    subject: "CN=example.test",
    issuer: "CN=Test CA",
    subjectAltNames: ["DNS:example.test", "DNS:other.test"],
    validFrom: Date.now() - 86400000,
    validTo: Date.now() + 5 * 86400000,
    serialNumber: "A1B2",
    fingerprint256: "AB:CD:EF",
    keyType: "ec",
    keyBits: 256,
    selfSigned: false,
    ...changes,
  };
}
export function tlsResult(changes: Partial<NetTlsResult> = {}): NetTlsResult {
  return {
    host: "example.test",
    port: 443,
    remoteAddress: "192.0.2.10",
    protocol: "TLSv1.3",
    cipher: {
      name: "TLS_AES_256_GCM_SHA384",
      standardName: "TLS_AES_256_GCM_SHA384",
      version: "TLSv1.3",
    },
    alpn: "h2",
    authorized: false,
    authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    hostnameMatches: false,
    chain: [
      certificate(),
      certificate({
        subject: "CN=Test CA",
        issuer: "CN=Test CA",
        selfSigned: true,
        validTo: Date.now() - 86400000,
      }),
    ],
    ms: 14,
    ...changes,
  };
}
