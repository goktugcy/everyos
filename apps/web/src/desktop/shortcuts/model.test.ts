import { describe, expect, it } from "vitest";
import { containerShortcutUrls } from "./model.ts";

describe("Docker shortcut addresses", () => {
  const container = {
    ports: [
      { privatePort: 80, publicPort: 8080, type: "tcp" as const, ip: "0.0.0.0" },
      { privatePort: 443, publicPort: 8443, type: "tcp" as const, ip: "::" },
      { privatePort: 9000, publicPort: 9001, type: "tcp" as const, ip: "127.0.0.1" },
      { privatePort: 53, publicPort: 5353, type: "udp" as const, ip: "0.0.0.0" },
      { privatePort: 3000, publicPort: null, type: "tcp" as const, ip: null },
    ],
    webUiTemplate: "http://[IP]:[PORT:80]/dashboard",
  };
  it("maps container ports to published ports, honoring templates and remote reachability", () => {
    expect(containerShortcutUrls(container, "server.example", false)).toEqual([
      "http://server.example:8080/dashboard",
      "http://server.example:8080/",
      "https://server.example:8443/",
    ]);
    expect(containerShortcutUrls(container, "localhost", false)).toContain(
      "http://localhost:9001/",
    );
    expect(containerShortcutUrls(container, "[2001:db8::1]", false)[0]).toBe(
      "http://[2001:db8::1]:8080/dashboard",
    );
  });
  it("never infers live endpoints from simulation or an unbound template", () => {
    expect(containerShortcutUrls(container, "server.example", true)).toEqual([]);
    expect(
      containerShortcutUrls(
        { ports: [], webUiTemplate: container.webUiTemplate },
        "server.example",
        false,
      ),
    ).toEqual([]);
  });
});
