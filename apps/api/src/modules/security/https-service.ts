import { X509Certificate } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { Database } from "@everyos/database";
import type { Logger } from "@everyos/logger";
import type { SecretBox } from "@everyos/security";
import { LAN_HTTPS_PORT, type HttpsView, type NetworkStatus } from "@everyos/shared";
import type { ApiConfig } from "../../config.ts";
import { isLoopbackAddress } from "../../http/client-info.ts";
import {
  certificateFingerprint,
  createLocalCa,
  issueServerCertificate,
  type CertificatePair,
} from "./x509.ts";

/*
 * HTTPS for EveryOS (docs/security-model.md). Tailscale Serve: EveryOS's own handler gives the
 * tailnet name a real certificate; its origin is then allowed and the loopback proxy trusted so
 * client addresses and HTTPS are seen. Local network: a second, HTTPS-only listener with
 * certificates from EveryOS's own certificate authority, kept sealed in the database (a restored
 * database brings the authority devices already trust).
 */

const SETTINGS_KEY = "security.https";
const AUTHORITY_KEY = "security.https.authority";
const CERTIFICATE_KEY = "security.https.certificate";
const AUTHORITY_CONTEXT = "https:authority:key:v1";
const CERTIFICATE_CONTEXT = "https:certificate:key:v1";
/** Certificates are re-issued this long before they expire (and whenever the names change). */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** Container and virtual interfaces would only make the certificate change all the time. */
const VIRTUAL_INTERFACE = /^(?:docker|br-|veth|virbr|cni|flannel|cali|vxlan|kube|lxc|tun|wg)/;

interface Settings {
  tailscale: { url: string; at: number; by: string } | null;
  lan: { enabled: boolean; port: number };
}

interface StoredPair {
  certPem: string;
  keySealed: string;
  createdAt: number;
}

export interface HostNames {
  dnsNames: string[];
  ipAddresses: string[];
}

/** This host's DNS names: its name, `<name>.local` (mDNS) and localhost. */
function hostDnsNames(): string[] {
  const host = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  return [...new Set([host, `${host}.local`, "localhost"])].filter((name) =>
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      name,
    ),
  );
}

const LOOPBACK = ["127.0.0.1", "::1"];

/**
 * Names and addresses other devices can use, from the agent's network status: the packaged API
 * may not open the netlink sockets that listing interfaces needs.
 */
export function hostNamesFromNetwork(status: NetworkStatus): HostNames {
  const ipAddresses = new Set(LOOPBACK);
  for (const entry of status.interfaces) {
    if (!entry.up || !["ethernet", "wireless", "tailscale", "other"].includes(entry.kind)) continue;
    for (const { address } of entry.addresses)
      if (!/^fe80:/i.test(address)) ipAddresses.add(address.replace(/%.*$/, ""));
  }
  return { dnsNames: hostDnsNames(), ipAddresses: [...ipAddresses] };
}

/** The same from Node itself (development); null when the process may not list interfaces. */
export function localHostNames(): HostNames | null {
  let interfaces: ReturnType<typeof networkInterfaces>;
  try {
    interfaces = networkInterfaces();
  } catch {
    return null;
  }
  const ipAddresses = new Set(LOOPBACK);
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || /^fe80:/i.test(entry.address)) continue;
      ipAddresses.add(entry.address.replace(/%.*$/, ""));
    }
  }
  return { dnsNames: hostDnsNames(), ipAddresses: [...ipAddresses] };
}

/** Starts, re-keys or stops the local-network HTTPS listener; returns why it could not listen. */
export interface LanListener {
  apply(next: { port: number; cert: string; key: string } | null): Promise<string | null>;
}

export class HttpsService {
  readonly #db: Database;
  readonly #secrets: SecretBox;
  readonly #config: ApiConfig;
  readonly #logger: Logger;
  readonly #now: () => number;
  /** Null when they cannot be found out now (the current certificate is then kept). */
  readonly #names: () => Promise<HostNames | null>;
  #listener: LanListener | null = null;
  #listening = false;
  #error: string | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: {
    db: Database;
    secrets: SecretBox;
    config: ApiConfig;
    logger: Logger;
    now: () => number;
    names?: () => Promise<HostNames | null>;
  }) {
    this.#db = deps.db;
    this.#secrets = deps.secrets;
    this.#config = deps.config;
    this.#logger = deps.logger.child({ component: "https" });
    this.#now = deps.now;
    this.#names = deps.names ?? (() => Promise.resolve(localHostNames()));
  }

  #read<T>(key: string): T | null {
    const row = this.#db.get<{ value: string }>(
      "SELECT value FROM instance_settings WHERE key = ?",
      key,
    );
    return row ? (JSON.parse(row.value) as T) : null;
  }

  #write(key: string, value: unknown): void {
    this.#db.run(
      `INSERT INTO instance_settings(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      this.#now(),
    );
  }

  settings(): Settings {
    const stored = this.#read<Partial<Settings>>(SETTINGS_KEY);
    return {
      tailscale: stored?.tailscale ?? null,
      lan: { enabled: false, port: LAN_HTTPS_PORT, ...stored?.lan },
    };
  }

  /* --------------------------------------------------------------- origins */

  /** Origins browsers may send besides the one they connected to. */
  origins(): string[] {
    const tailscale = this.settings().tailscale?.url;
    return [...this.#config.server.publicOrigins, ...(tailscale ? [tailscale] : [])];
  }

  allowsOrigin(origin: string): boolean {
    return this.origins().includes(origin);
  }

  /** Tailscale Serve reaches EveryOS from loopback with the client's address and scheme. */
  trustsLoopbackProxy(address: string): boolean {
    return this.settings().tailscale !== null && isLoopbackAddress(address);
  }

  /* -------------------------------------------------------------- Tailscale */

  /** Records the Serve handler the agent just turned on or off. */
  recordTailscale(url: string | null, by: string): void {
    const settings = this.settings();
    this.#write(SETTINGS_KEY, {
      ...settings,
      tailscale: url ? { url, at: this.#now(), by } : null,
    });
  }

  /* -------------------------------------------------------- local network */

  attach(listener: LanListener): void {
    this.#listener = listener;
  }

  /** Starts the listener when it is on, and keeps its certificate current. */
  async start(): Promise<void> {
    await this.#apply();
    this.#timer ??= setInterval(() => {
      if (this.settings().lan.enabled)
        void this.#apply().catch((error: unknown) =>
          this.#logger.warn("HTTPS certificate check failed", { error }),
        );
    }, CHECK_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async setLan(enabled: boolean, port: number): Promise<HttpsView> {
    const settings = this.settings();
    if (enabled && port === this.#config.server.port)
      throw new Error("The HTTPS port must differ from the HTTP port");
    this.#write(SETTINGS_KEY, { ...settings, lan: { enabled, port } });
    await this.#apply();
    return this.view();
  }

  async #apply(): Promise<void> {
    const { lan } = this.settings();
    if (!lan.enabled) {
      if (this.#listener) await this.#listener.apply(null);
      this.#listening = false;
      this.#error = null;
      return;
    }
    const pair = await this.#certificate();
    if (!this.#listener) return;
    this.#error = await this.#listener.apply({
      port: lan.port,
      cert: pair.certPem,
      key: pair.keyPem,
    });
    this.#listening = this.#error === null;
    if (this.#error)
      this.#logger.warn("Local-network HTTPS is not listening", { error: this.#error });
  }

  #authority(): CertificatePair & { createdAt: number } {
    const stored = this.#read<StoredPair>(AUTHORITY_KEY);
    if (stored)
      return {
        certPem: stored.certPem,
        keyPem: this.#secrets.open(stored.keySealed, AUTHORITY_CONTEXT),
        createdAt: stored.createdAt,
      };
    const host =
      hostname()
        .replace(/[^A-Za-z0-9.-]/g, "")
        .slice(0, 40) || "host";
    const created = createLocalCa({ commonName: `EveryOS ${host}`, now: this.#now() });
    this.#write(AUTHORITY_KEY, {
      certPem: created.certPem,
      keySealed: this.#secrets.seal(created.keyPem, AUTHORITY_CONTEXT),
      createdAt: this.#now(),
    } satisfies StoredPair);
    this.#logger.info("Created the local certificate authority");
    return { ...created, createdAt: this.#now() };
  }

  /** The current server certificate, issued again when names changed or expiry is near. */
  async #certificate(): Promise<CertificatePair> {
    const authority = this.#authority();
    const names = await this.#names().catch(() => null);
    const stored = this.#read<StoredPair>(CERTIFICATE_KEY);
    if (stored) {
      const certificate = new X509Certificate(stored.certPem);
      const same =
        names === null ||
        [...new Set(sanEntries(certificate))].sort().join(",") ===
          [...new Set([...names.dnsNames, ...names.ipAddresses].map(canonical))].sort().join(",");
      if (
        same &&
        Date.parse(certificate.validTo) - this.#now() > RENEW_BEFORE_MS &&
        certificate.checkIssued(new X509Certificate(authority.certPem))
      )
        return {
          certPem: stored.certPem,
          keyPem: this.#secrets.open(stored.keySealed, CERTIFICATE_CONTEXT),
        };
    }
    const subject = names ?? { dnsNames: hostDnsNames(), ipAddresses: LOOPBACK };
    const issued = issueServerCertificate({
      ca: authority,
      commonName: subject.dnsNames[0] ?? "everyos",
      dnsNames: subject.dnsNames,
      ipAddresses: subject.ipAddresses,
      now: this.#now(),
    });
    this.#write(CERTIFICATE_KEY, {
      certPem: issued.certPem,
      keySealed: this.#secrets.seal(issued.keyPem, CERTIFICATE_CONTEXT),
      createdAt: this.#now(),
    } satisfies StoredPair);
    this.#logger.info("Issued the local-network HTTPS certificate", {
      names: subject.dnsNames.length + subject.ipAddresses.length,
    });
    return issued;
  }

  /** The certificate authority devices install (public; never its key). */
  authorityPem(): string {
    return this.#authority().certPem;
  }

  view(): HttpsView {
    const { tailscale, lan } = this.settings();
    const authority = this.#read<StoredPair>(AUTHORITY_KEY);
    const certificate = this.#read<StoredPair>(CERTIFICATE_KEY);
    const parsed = certificate ? new X509Certificate(certificate.certPem) : null;
    const port = lan.port;
    // The addresses the certificate covers, as other devices would type them.
    const urls = (parsed ? sanEntries(parsed) : [])
      .filter((name) => name !== "localhost" && !isLoopbackAddress(name))
      .map((name) => `https://${name.includes(":") ? `[${name}]` : name}:${port}`);
    return {
      tailscale: {
        url: tailscale?.url ?? null,
        enabledAt: tailscale?.at ?? null,
        enabledBy: tailscale?.by ?? null,
      },
      lan: {
        enabled: lan.enabled,
        port,
        listening: lan.enabled && this.#listening,
        error: lan.enabled ? this.#error : null,
        urls,
        authority: authority
          ? {
              fingerprint: certificateFingerprint(authority.certPem),
              createdAt: authority.createdAt,
            }
          : null,
        certificate:
          parsed && certificate
            ? {
                fingerprint: certificateFingerprint(certificate.certPem),
                notAfter: Date.parse(parsed.validTo),
                names: sanEntries(parsed),
              }
            : null,
        loopbackOnly: ["127.0.0.1", "::1", "localhost"].includes(this.#config.server.host),
      },
    };
  }
}

/** IPv6 in one canonical (compressed, lower-case) form, so address lists compare reliably. */
const canonical = (entry: string) =>
  entry.includes(":") ? new URL(`http://[${entry}]`).hostname.slice(1, -1) : entry.toLowerCase();

/** "DNS:a, IP Address:1.2.3.4" → ["a", "1.2.3.4"]. */
function sanEntries(certificate: X509Certificate): string[] {
  return (certificate.subjectAltName ?? "")
    .split(", ")
    .map((entry) => entry.replace(/^(?:DNS|IP Address):/, ""))
    .filter(Boolean)
    .map(canonical);
}
