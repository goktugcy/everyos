import type { AptUpdates } from "@otuken/shared";

/**
 * `apt list --upgradable` (C locale), e.g.
 * "openssl/noble-updates,noble-security 3.0.13-0ubuntu3.6 arm64 [upgradable from: 3.0.13-0ubuntu3.5]".
 */
export function parseAptUpgradable(
  text: string,
): Pick<AptUpdates, "total" | "security" | "packages"> {
  const packages: AptUpdates["packages"] = [];
  for (const line of text.split("\n")) {
    const match = /^([a-z0-9][a-z0-9+.-]*)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:/.exec(
      line.trim(),
    );
    if (!match) continue;
    packages.push({
      name: match[1]!.slice(0, 128),
      version: match[3]!.slice(0, 128),
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
