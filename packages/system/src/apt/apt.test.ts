import { describe, expect, it } from "vitest";
import { parseAptPolicy, parseAptShow, parseAptSummary, parseAptUpgradable } from "../linux/apt.ts";
import { createAptSimulator } from "../simulated/apt-simulator.ts";
import { createAptManager } from "./manager.ts";

const POLICY = `openssl:
  Installed: 3.0.13-0ubuntu3.5
  Candidate: 3.0.13-0ubuntu3.6
  Version table:
     3.0.13-0ubuntu3.6 500
        500 http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 Packages
        500 http://ports.ubuntu.com/ubuntu-ports noble-security/main arm64 Packages
 *** 3.0.13-0ubuntu3.5 100
        100 /var/lib/dpkg/status
     3.0.13-0ubuntu3 500
        500 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 Packages
`;

const SHOW = `Package: openssl
Version: 3.0.13-0ubuntu3.6
Priority: important
Section: utils
Installed-Size: 2167
Maintainer: Ubuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>
Homepage: https://www.openssl.org/
Description: Secure Sockets Layer toolkit - cryptographic utility
 This package is part of the OpenSSL project's implementation of the SSL
 and TLS cryptographic protocols.
 .
 It contains the general-purpose command line binary /usr/bin/openssl.

Package: openssl
Version: 3.0.13-0ubuntu3
`;

describe("apt parsers", () => {
  it("refuses to bypass signed EveryOS updates through an APT package request", async () => {
    const updates = createAptManager().upgrade(["everyos"], new AbortController().signal);
    await expect(updates.next()).rejects.toThrow("signed release workflow");
  });
  it("reads installed and candidate versions with the candidate's repositories", () => {
    expect(parseAptPolicy(POLICY)).toEqual({
      installed: "3.0.13-0ubuntu3.5",
      candidate: "3.0.13-0ubuntu3.6",
      origins: ["noble-updates/main", "noble-security/main"],
    });
    expect(
      parseAptPolicy("foo:\n  Installed: (none)\n  Candidate: 1.0\n  Version table:\n"),
    ).toMatchObject({
      installed: null,
      candidate: "1.0",
    });
  });

  it("reads the first package stanza with multi-line descriptions", () => {
    const fields = parseAptShow(SHOW);
    expect(fields.Version).toBe("3.0.13-0ubuntu3.6");
    expect(fields["Installed-Size"]).toBe("2167");
    expect(fields.Description!.split("\n")[0]).toBe(
      "Secure Sockets Layer toolkit - cryptographic utility",
    );
    expect(fields.Description).toContain("\n\nIt contains");
  });

  it("parses the upgrade summary and the upgradable list with current versions", () => {
    expect(parseAptSummary("3 upgraded, 0 newly installed, 0 to remove and 1 not upgraded.")).toBe(
      3,
    );
    expect(parseAptSummary("Reading package lists...")).toBeNull();
    const list = parseAptUpgradable(
      "Listing...\nopenssl/noble-updates,noble-security 3.0.13-0ubuntu3.6 arm64 [upgradable from: 3.0.13-0ubuntu3.5]\n",
    );
    expect(list.packages[0]).toEqual({
      name: "openssl",
      version: "3.0.13-0ubuntu3.6",
      currentVersion: "3.0.13-0ubuntu3.5",
      suites: "noble-updates,noble-security",
      security: true,
    });
  });

  it("simulates refresh and selective upgrades in memory", async () => {
    const apt = createAptSimulator(() => 1_000_000);
    expect((await apt.updates()).total).toBe(5);
    const events = [];
    for await (const event of apt.upgrade(["curl"], new AbortController().signal))
      events.push(event);
    expect(events.at(-1)).toEqual({
      type: "done",
      ok: true,
      exitCode: 0,
      upgraded: 1,
      busy: false,
    });
    expect((await apt.updates()).packages.map((p) => p.name)).not.toContain("curl");
  });
});
