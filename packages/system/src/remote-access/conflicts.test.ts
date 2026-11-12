import { describe, expect, it } from "vitest";
import type { RemoteAccessNode } from "@everyos/shared";
import { emptyRemoteNode } from "./providers.ts";
import { remoteAccessConflicts, remoteRoutesOverlap } from "./conflicts.ts";

describe("remote access conflict detection", () => {
  it("compares real IPv4 and IPv6 networks, including nested and mapped ranges", () => {
    for (const [a, b] of [
      ["192.168.1.1/24", "192.168.0.0/16"],
      ["fd00:1234::1/64", "fd00::/8"],
      ["::ffff:192.168.1.1/120", "::ffff:c0a8:100/120"],
      ["::/0", "2001:db8::1/128"],
    ])
      expect(remoteRoutesOverlap(a!, b!)).toBe(true);
    for (const value of [
      "garbage",
      "::%wg0/64",
      "fd00::/129",
      "1.2.3.4/-1",
      "1.2.3.4/24/0",
      "::/x",
    ])
      expect(remoteRoutesOverlap(value, "::/0")).toBe(false);
    expect(remoteRoutesOverlap("192.168.1.0/24", "192.168.2.0/24")).toBe(false);
    expect(remoteRoutesOverlap("::/0", "0.0.0.0/0")).toBe(false);
  });
  const active = () =>
    (["tailscale", "netbird"] as const).map((id) => ({
      ...emptyRemoteNode(id),
      installed: true,
      available: true,
      state: "connected" as const,
      dnsEnabled: true,
      acceptsRoutes: true,
      routeVisibility: true,
      defaultRoute: false,
      routes: [id === "tailscale" ? "10.20.0.0/16" : "10.20.1.0/24"],
    }));
  it("reports simultaneous DNS, subnet and default-route conflicts without mutating providers", () => {
    const nodes = active().map((node) => ({ ...node, defaultRoute: true }));
    const before = JSON.stringify(nodes);
    expect(remoteAccessConflicts(nodes).map((v) => v.kind)).toEqual([
      "multiple-active",
      "dns",
      "exit-node",
      "subnet",
    ]);
    expect(remoteAccessConflicts(nodes).find((v) => v.kind === "exit-node")?.severity).toBe(
      "critical",
    );
    expect(JSON.stringify(nodes)).toBe(before);
  });
  it("warns about future route-policy overlap and marks unreadable routing or DNS explicitly", () => {
    const nodes = active().map((node) => ({
      ...node,
      routes: [],
      routeVisibility: false,
      dnsEnabled: null,
    }));
    expect(remoteAccessConflicts(nodes).map((v) => v.kind)).toEqual([
      "multiple-active",
      "visibility",
      "route-policy",
    ]);
    expect(remoteAccessConflicts([nodes[0]!, { ...nodes[1]!, state: "disconnected" }])).toEqual([]);
    expect(remoteAccessConflicts([nodes[0]!, { ...nodes[1]!, available: false }])).toEqual([]);
  });
  it("warns while a second VPN is connecting and does not confuse exit-node servers with exit consumers", () => {
    const nodes: RemoteAccessNode[] = active().map((node) => ({
      ...node,
      advertisesExitNode: true,
    }));
    expect(remoteAccessConflicts(nodes).some((conflict) => conflict.kind === "exit-node")).toBe(
      false,
    );
    nodes[1] = { ...nodes[1]!, state: "connecting" };
    expect(
      remoteAccessConflicts(nodes).some((conflict) => conflict.kind === "multiple-active"),
    ).toBe(true);
  });
});
