import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { isIP } from "node:net";

/** A PEM certificate and its PKCS#8 PEM private key (ECDSA P-256). */
export interface CertificatePair {
  certPem: string;
  keyPem: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Apple and Chrome cap trusted TLS server certificates at 398 days; stay a day under. */
const MAX_SERVER_DAYS = 397;
const MAX_CA_DAYS = 36_500;

const OID = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

// DER: just the types a certificate needs.

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const length: number[] = [];
  for (let n = body.length; n > 0; n = Math.floor(n / 256)) length.unshift(n % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | length.length, ...length]), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const boolean = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const octetString = (bytes: Buffer) => tlv(0x04, bytes);
const utf8String = (text: string) => tlv(0x0c, Buffer.from(text, "utf8"));
/** A BIT STRING of whole bytes (keys, signatures). */
const bitString = (bytes: Buffer) => tlv(0x03, Buffer.from([0]), bytes);
/** Context-specific constructed `[n] EXPLICIT`. */
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner);
/** Context-specific primitive `[n] IMPLICIT` over the underlying type's contents. */
const implicit = (n: number, contents: Buffer) => tlv(0x80 | n, contents);

/** A non-negative INTEGER (a byte-sized number or big-endian bytes), minimal two's complement. */
function integer(value: Buffer | number): Buffer {
  const bytes = typeof value === "number" ? Buffer.from([value]) : value;
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const minimal = bytes.subarray(start);
  // A set high bit would read as negative.
  return tlv(
    0x02,
    ((minimal[0] ?? 0) & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal,
  );
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    const chunk = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) chunk.unshift(0x80 | (n & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime through 2049, GeneralizedTime from 2050 on (RFC 5280 4.1.2.5), whole seconds. */
function time(ms: number): Buffer {
  const digits = new Date(ms).toISOString().slice(0, 19).replace(/\D/g, "");
  return new Date(ms).getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${digits}Z`, "ascii"));
}

/** KeyUsage bits 0–7 as a DER named-bit list: trailing zero bits are dropped as unused. */
function keyUsage(...bits: number[]): Buffer {
  const byte = bits.reduce((all, bit) => all | (0x80 >> bit), 0);
  return tlv(0x03, Buffer.from([7 - Math.max(...bits), byte]));
}

function extension(id: string, value: Buffer, critical = false): Buffer {
  return critical
    ? sequence(oid(id), boolean(true), octetString(value))
    : sequence(oid(id), octetString(value));
}

/** One attribute per RDN. */
function name(...attributes: [type: string, value: string][]): Buffer {
  return sequence(
    ...attributes.map(([type, value]) => set(sequence(oid(type), utf8String(value)))),
  );
}

interface Der {
  tag: number;
  /** The whole TLV. */
  raw: Buffer;
  /** Its contents. */
  body: Buffer;
}

/** The TLVs laid end to end in `input` (definite lengths only, as DER requires). */
function readDer(input: Buffer): Der[] {
  const out: Der[] = [];
  for (let at = 0; at < input.length;) {
    const tag = input.readUInt8(at);
    let length = input.readUInt8(at + 1);
    let header = 2;
    if ((length & 0x80) !== 0) {
      const size = length & 0x7f;
      length = input.readUIntBE(at + 2, size);
      header += size;
    }
    const end = at + header + length;
    if (end > input.length) throw new Error("Truncated DER");
    out.push({ tag, raw: input.subarray(at, end), body: input.subarray(at + header, end) });
    at = end;
  }
  return out;
}

function element(input: Buffer, index = 0): Der {
  const found = readDer(input)[index];
  if (!found) throw new Error("Malformed DER");
  return found;
}

// Certificates.

/** RFC 5280 method 1: SHA-1 of the subjectPublicKey BIT STRING contents, unused-bits byte excluded. */
function keyIdentifier(spki: Buffer): Buffer {
  const subjectPublicKey = element(element(spki).body, 1);
  return createHash("sha1").update(subjectPublicKey.body.subarray(1)).digest();
}

function newKey(): { privateKey: KeyObject; spki: Buffer; keyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    spki: publicKey.export({ type: "spki", format: "der" }),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** 16 random bytes, top bit cleared so the serial is positive, and never zero. */
function serialNumber(): Buffer {
  for (;;) {
    const bytes = randomBytes(16);
    bytes.writeUInt8(bytes.readUInt8(0) & 0x7f, 0);
    if (bytes.some((byte) => byte !== 0)) return bytes;
  }
}

function validity(days: number, max: number): number {
  if (!Number.isInteger(days) || days < 1 || days > max)
    throw new RangeError(`A validity of ${days} days is outside 1–${max}`);
  return days * DAY;
}

function commonName(value: string): [string, string] {
  if (value.length < 1 || value.length > 64) throw new Error("A common name is 1–64 characters");
  return [OID.commonName, value];
}

function signCertificate(input: {
  issuer: Buffer;
  subject: Buffer;
  spki: Buffer;
  notBefore: number;
  notAfter: number;
  extensions: Buffer[];
  signer: KeyObject;
}): string {
  // ecdsa-with-SHA256 takes no parameters, not even NULL.
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const tbs = sequence(
    explicit(0, integer(2)), // v3
    integer(serialNumber()),
    algorithm,
    input.issuer,
    sequence(time(input.notBefore), time(input.notAfter)),
    input.subject,
    input.spki,
    explicit(3, sequence(...input.extensions)),
  );
  // Node signs EC keys with a DER-encoded ECDSA-Sig-Value, as X.509 wants.
  const der = sequence(tbs, algorithm, bitString(sign("sha256", tbs, input.signer)));
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * EveryOS's own local certificate authority: the owner trusts it once on each device and
 * EveryOS re-issues its HTTPS certificate whenever the host's names or addresses change.
 * Self-signed (`O=EveryOS, CN=<commonName>`), it may only issue end-entity certificates and is
 * valid from an hour before `now` (clock skew) until `validDays` after it (default ten years).
 */
export function createLocalCa(input: {
  commonName: string;
  now: number;
  validDays?: number;
}): CertificatePair {
  const lifetime = validity(input.validDays ?? 3650, MAX_CA_DAYS);
  const subject = name([OID.organization, "EveryOS"], commonName(input.commonName));
  const key = newKey();
  const certPem = signCertificate({
    issuer: subject,
    subject,
    spki: key.spki,
    notBefore: input.now - HOUR,
    notAfter: input.now + lifetime,
    extensions: [
      extension(OID.basicConstraints, sequence(boolean(true), integer(0)), true),
      extension(OID.keyUsage, keyUsage(5, 6), true), // keyCertSign, cRLSign
      extension(OID.subjectKeyIdentifier, octetString(keyIdentifier(key.spki))),
    ],
    signer: key.privateKey,
  });
  return { certPem, keyPem: key.keyPem };
}

/** What issuing needs from the CA: its exact subject bytes, key identifier, expiry and key. */
function readCa(ca: CertificatePair) {
  const cert = new X509Certificate(ca.certPem);
  const privateKey = createPrivateKey(ca.keyPem);
  if (!cert.ca || privateKey.asymmetricKeyType !== "ec" || !cert.checkPrivateKey(privateKey))
    throw new Error("Not an EC CA certificate with its own private key");
  const fields = readDer(element(element(cert.raw).body).body);
  const at = fields[0]?.tag === 0xa0 ? 1 : 0; // the version field is optional
  const subject = fields[at + 4];
  const spki = fields[at + 5];
  if (!subject || !spki) throw new Error("Malformed CA certificate");
  // The CA's own subjectKeyIdentifier, else the one RFC 5280 method 1 gives.
  let keyId = keyIdentifier(spki.raw);
  const extensions = fields.find((field) => field.tag === 0xa3);
  for (const ext of extensions ? readDer(element(extensions.body).body) : []) {
    const parts = readDer(ext.body);
    const value = parts.at(-1);
    if (value && parts[0]?.raw.equals(oid(OID.subjectKeyIdentifier)))
      keyId = element(value.body).body;
  }
  return { subject: subject.raw, keyId, notAfter: cert.validToDate.getTime(), privateKey };
}

const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lowercase, without a trailing dot; IP addresses belong in `ipAddresses`. */
function dnsName(value: string): string {
  const host = value.toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || isIP(host) !== 0 || !host.split(".").every((l) => DNS_LABEL.test(l)))
    throw new Error(`Not a valid DNS name: ${value}`);
  return host;
}

/** 4 bytes for IPv4, 16 for IPv6 (zone ids have no place in a certificate). */
function ipAddress(value: string): Buffer {
  const family = isIP(value);
  if (family === 4) return Buffer.from(value.split(".").map(Number));
  if (family !== 6 || value.includes("%")) throw new Error(`Not a valid IP address: ${value}`);
  // A trailing dotted quad (`::ffff:192.168.1.20`) becomes two groups.
  const text = value.replace(/(\d+\.\d+\.\d+\.\d+)$/, (quad) =>
    (ipAddress(quad).toString("hex").match(/..../g) ?? []).join(":"),
  );
  const [head = "", tail = ""] = text.split("::");
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const left = groups(head);
  const right = groups(tail);
  // `::` stands for the zero groups that make eight.
  const all = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const bytes = Buffer.alloc(16);
  all.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
  return bytes;
}

/** GeneralNames with dNSName [2] and iPAddress [7] entries, deduplicated. */
function subjectAltNames(dnsNames: string[], ipAddresses: string[]): Buffer {
  const entries = new Map<string, Buffer>();
  for (const value of dnsNames) {
    const host = dnsName(value);
    entries.set(`dns:${host}`, implicit(2, Buffer.from(host, "ascii")));
  }
  for (const value of ipAddresses) {
    const bytes = ipAddress(value);
    entries.set(`ip:${bytes.toString("hex")}`, implicit(7, bytes));
  }
  if (entries.size === 0) throw new Error("A server certificate needs a DNS name or IP address");
  return sequence(...entries.values());
}

/**
 * A TLS server certificate signed by `ca`, for every DNS name and IP address given. Its whole
 * validity window (from an hour before `now`) is at most 397 days and never outlives the CA.
 */
export function issueServerCertificate(input: {
  ca: CertificatePair;
  commonName: string;
  dnsNames: string[];
  ipAddresses: string[];
  now: number;
  validDays?: number;
}): CertificatePair {
  const lifetime = validity(input.validDays ?? MAX_SERVER_DAYS, MAX_SERVER_DAYS);
  const subject = name(commonName(input.commonName));
  const names = subjectAltNames(input.dnsNames, input.ipAddresses);
  const ca = readCa(input.ca);
  if (ca.notAfter <= input.now) throw new Error("The local CA has expired");
  const key = newKey();
  const notBefore = input.now - HOUR;
  const certPem = signCertificate({
    issuer: ca.subject,
    subject,
    spki: key.spki,
    notBefore,
    notAfter: Math.min(notBefore + lifetime, ca.notAfter),
    extensions: [
      extension(OID.basicConstraints, sequence(), true), // CA:FALSE is the DER default
      extension(OID.keyUsage, keyUsage(0), true), // digitalSignature, all an ECDSA key does
      extension(OID.extKeyUsage, sequence(oid(OID.serverAuth))),
      extension(OID.subjectAltName, names),
      extension(OID.subjectKeyIdentifier, octetString(keyIdentifier(key.spki))),
      extension(OID.authorityKeyIdentifier, sequence(implicit(0, ca.keyId))),
    ],
    signer: ca.privateKey,
  });
  return { certPem, keyPem: key.keyPem };
}

/** SHA-256 fingerprint "AA:BB:..." of a PEM certificate. */
export function certificateFingerprint(certPem: string): string {
  const digest = createHash("sha256").update(new X509Certificate(certPem).raw).digest();
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
}
