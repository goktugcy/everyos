import type { AptUpdates } from "@everyos/shared";

/**
 * `apt list --upgradable` (C locale), e.g.
 * "openssl/noble-updates,noble-security 3.0.13-0ubuntu3.6 arm64 [upgradable from: 3.0.13-0ubuntu3.5]".
 */
export function parseAptUpgradable(
  text: string,
): Pick<AptUpdates, "total" | "security" | "packages"> {
  const packages: AptUpdates["packages"] = [];
  for (const line of text.split("\n")) {
    const match =
      /^([a-z0-9][a-z0-9+.-]*)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]\s]+)\]/.exec(
        line.trim(),
      );
    if (!match) continue;
    packages.push({
      name: match[1]!.slice(0, 128),
      version: match[3]!.slice(0, 128),
      currentVersion: match[4]!.slice(0, 128),
      suites: match[2]!.slice(0, 256),
      security: match[2]!.split(",").some((suite) => suite.endsWith("-security")),
    });
  }
  return {
    total: packages.length,
    security: packages.filter((p) => p.security).length,
    packages: packages
      .sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name))
      .slice(0, 500),
  };
}

/**
 * `apt-cache policy <pkg>` (C locale): installed and candidate versions and
 * the repositories offering the candidate.
 */
export function parseAptPolicy(text: string): {
  installed: string | null;
  candidate: string | null;
  origins: string[];
} {
  const installed = /^\s*Installed:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const candidate = /^\s*Candidate:\s*(\S+)/m.exec(text)?.[1] ?? null;
  const origins: string[] = [];
  const table = text.split(/^\s*Version table:\s*$/m)[1] ?? "";
  let inCandidate = false;
  for (const line of table.split("\n")) {
    const version = /^\s*(?:\*\*\*\s+)?(\S+)\s+-?\d+\s*$/.exec(line);
    if (version) {
      inCandidate = version[1] === candidate;
      continue;
    }
    // "        500 http://ports.ubuntu.com/ubuntu-ports noble-security/main arm64 Packages"
    const origin = /^\s+-?\d+\s+(\S+)\s+(\S+)\s/.exec(line);
    if (inCandidate && origin && origin[1] !== "/var/lib/dpkg/status") origins.push(origin[2]!);
  }
  const none = (value: string | null) => (value === null || value === "(none)" ? null : value);
  return {
    installed: none(installed),
    candidate: none(candidate),
    origins: [...new Set(origins)].slice(0, 16),
  };
}

/** First stanza of `apt-cache show --no-all-versions <pkg>` as fields. */
export function parseAptShow(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of (text.split(/\n\s*\n/)[0] ?? "").split("\n")) {
    const field = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
    if (field) {
      key = field[1]!;
      fields[key] = field[2]!;
    } else if (key && /^\s/.test(line)) {
      fields[key] += `\n${line.trim() === "." ? "" : line.trim()}`;
    }
  }
  return fields;
}

/** "3 upgraded, 0 newly installed, 0 to remove and 1 not upgraded." → 3 */
export function parseAptSummary(line: string): number | null {
  const match = /^(\d+) upgraded, \d+ newly installed, \d+ to remove/.exec(line.trim());
  return match ? Number(match[1]) : null;
}
