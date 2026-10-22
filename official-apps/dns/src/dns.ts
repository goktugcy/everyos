import {
  DNS_RECORD_TYPES,
  type DnsRecord,
  type DnsRecordType,
  type NetDnsResult,
} from "@everyos/app-sdk";

export const COMMON_TYPES: readonly DnsRecordType[] = ["A", "AAAA", "CNAME", "MX", "NS", "TXT"];
export const PUBLIC_SERVERS = [
  { id: "cloudflare", address: "1.1.1.1" },
  { id: "google", address: "8.8.8.8" },
  { id: "quad9", address: "9.9.9.9" },
] as const;

export function isIp(value: string): boolean {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(value))
    return true;
  if (!value.includes(":") || !/^[\da-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export type NameProblem = "empty" | "tooLong" | "invalid" | "needsAddress";

/** URL's IDNA conversion preserves label order, including DNS service labels. */
export function normalizeName(
  input: string,
  type: DnsRecordType,
): { name: string } | { problem: NameProblem } {
  const value = input.trim().replace(/\.$/, "");
  if (!value) return { problem: "empty" };
  if (isIp(value)) return type === "PTR" ? { name: value } : { problem: "needsAddress" };
  if (/[\s/@:#?%\\[\]]/.test(value)) return { problem: "invalid" };
  let ascii: string;
  try {
    ascii = new URL(`http://${value}/`).hostname;
  } catch {
    return { problem: "invalid" };
  }
  if (ascii.length > 253) return { problem: "tooLong" };
  if (
    !ascii ||
    isIp(ascii) ||
    !ascii
      .split(".")
      .every((label) => label.length <= 63 && /^_?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  )
    return { problem: "invalid" };
  return { name: ascii.toLowerCase() };
}

const quoted = (text: string) => `"${text.replace(/["\\]/g, (char) => `\\${char}`)}"`;
const dotted = (value: string) => `${value.replace(/\.$/, "")}.`;

export function recordValue(record: DnsRecord): string {
  switch (record.type) {
    case "A":
    case "AAAA":
      return record.address;
    case "CNAME":
    case "NS":
    case "PTR":
      return dotted(record.value);
    case "MX":
      return `${record.priority} ${dotted(record.exchange)}`;
    case "TXT":
      return quoted(record.text);
    case "SOA":
      return `${dotted(record.nsname)} ${dotted(record.hostmaster)} ${record.serial} ${record.refresh} ${record.retry} ${record.expire} ${record.minttl}`;
    case "CAA":
      return `${record.critical} ${record.tag} ${quoted(record.value)}`;
    case "SRV":
      return `${record.priority} ${record.weight} ${record.port} ${dotted(record.target)}`;
  }
}

export function zoneLines(result: NetDnsResult): string[] {
  return result.records.map((record) =>
    [dotted(result.name), "ttl" in record ? record.ttl : "", "IN", record.type, recordValue(record)]
      .filter((part) => part !== "")
      .join("\t"),
  );
}

export function txtKind(
  name: string,
  text: string,
): "spf" | "dmarc" | "dkim" | "verification" | null {
  const value = text.trim().toLowerCase();
  if (value.startsWith("v=spf1")) return "spf";
  if (value.startsWith("v=dmarc1") || name.toLowerCase().startsWith("_dmarc.")) return "dmarc";
  if (value.startsWith("v=dkim1") || name.toLowerCase().includes("._domainkey.")) return "dkim";
  return /^[a-z0-9-]+(-site)?-verification=|^[a-z0-9-]+-domain-verification=/.test(value)
    ? "verification"
    : null;
}

export interface Settings {
  name: string;
  type: "common" | DnsRecordType;
  server: string;
  custom: string;
  port: string;
}
export const DEFAULT_SETTINGS: Settings = {
  name: "",
  type: "common",
  server: "system",
  custom: "",
  port: "53",
};
export const MAX_HISTORY = 50;
export interface HistoryEntry {
  name: string;
  types: DnsRecordType[];
  server: string | null;
  port: number;
  at: number;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
export function readSettings(value: unknown): Settings {
  const v = object(value);
  return {
    name: typeof v.name === "string" ? v.name.slice(0, 1024) : "",
    type:
      v.type === "common" || DNS_RECORD_TYPES.some((type) => type === v.type)
        ? (v.type as Settings["type"])
        : "common",
    server:
      typeof v.server === "string" &&
      ["system", "custom", ...PUBLIC_SERVERS.map((s) => s.id)].includes(v.server)
        ? v.server
        : "system",
    custom: typeof v.custom === "string" ? v.custom.slice(0, 64) : "",
    port: typeof v.port === "string" && /^\d{1,5}$/.test(v.port) ? v.port : "53",
  };
}
export function readHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_HISTORY).flatMap((entry: unknown) => {
    const v = object(entry);
    if (
      typeof v.name !== "string" ||
      !Array.isArray(v.types) ||
      !v.types.length ||
      v.types.length > DNS_RECORD_TYPES.length ||
      !v.types.every((type: unknown) => DNS_RECORD_TYPES.some((known) => known === type)) ||
      !(v.server === null || (typeof v.server === "string" && isIp(v.server))) ||
      typeof v.port !== "number" ||
      !Number.isInteger(v.port) ||
      v.port < 1 ||
      v.port > 65535 ||
      typeof v.at !== "number" ||
      !Number.isFinite(v.at) ||
      Number.isNaN(new Date(v.at).getTime()) ||
      v.at < 0
    )
      return [];
    const types = v.types as DnsRecordType[];
    const normalized = normalizeName(v.name, types[0]!);
    if (!("name" in normalized)) return [];
    return [
      {
        name: normalized.name,
        types: [...new Set(types)],
        server: v.server,
        port: v.port,
        at: v.at,
      },
    ];
  });
}
export function addHistory(list: readonly HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [
    entry,
    ...list.filter(
      (other) =>
        !(
          other.name === entry.name &&
          other.server === entry.server &&
          other.port === entry.port &&
          other.types.join() === entry.types.join()
        ),
    ),
  ].slice(0, MAX_HISTORY);
}
