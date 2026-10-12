import type { InstalledAppView } from "@everyos/shared";

/** Use only real published web ports, honoring loopback restrictions and simulator labels. */
export function appLaunchLinks(app: InstalledAppView, hostname: string) {
  if (app.source !== "host" || app.state !== "running") return [];
  return app.ports
    .filter(
      (port, index, ports) =>
        ports.findIndex((entry) => entry.port === port.port) === index &&
        (!port.hostIp ||
          !["127.0.0.1", "::1"].includes(port.hostIp) ||
          ["localhost", "127.0.0.1", "[::1]"].includes(hostname)),
    )
    .map((port) => ({
      port: port.port,
      href:
        (app.web?.scheme ?? "http") + "://" + hostname + ":" + port.port + (app.web?.path ?? "/"),
    }));
}
