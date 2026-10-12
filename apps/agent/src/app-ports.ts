import { inspectCompose, object, parseCompose } from "@everyos/catalogs/compose";
import type { ContainerSummary } from "@everyos/shared";
import { stringify } from "yaml";

/** Keep automatic allocations stable when an owned deployment is recreated. */
export function retainAssignedPorts(input: string, previous: string): string {
  const doc = parseCompose(input);
  const pinned = inspectCompose(previous).ports;
  const previousDoc = parseCompose(previous);
  for (const port of inspectCompose(input).ports) {
    if (port.host !== null) continue;
    const existing = pinned.find(
      (entry) =>
        entry.service === port.service &&
        entry.index === port.index &&
        entry.container === port.container &&
        entry.protocol === port.protocol,
    );
    if (!existing?.host) continue;
    const ports = object(object(doc.services)[port.service]).ports as unknown[];
    const oldPorts = object(object(previousDoc.services)[port.service]).ports as unknown[];
    const mapping = object(ports[port.index]);
    if (mapping.host_ip !== object(oldPorts[port.index]).host_ip) continue;
    ports[port.index] = { ...mapping, published: String(existing.host) };
  }
  return stringify(doc, { lineWidth: 0 });
}

/** Persist only ports actually reported by the newly deployed project. */
export function pinAssignedPorts(
  input: string,
  project: string,
  containers: ContainerSummary[],
): string {
  const doc = parseCompose(input);
  for (const port of inspectCompose(input).ports) {
    if (port.host !== null) continue;
    const ports = object(object(doc.services)[port.service]).ports as unknown[];
    const mapping = object(ports[port.index]);
    const binding = containers
      .filter((container) => container.project === project && container.service === port.service)
      .flatMap((container) => container.ports)
      .find(
        (entry) =>
          entry.privatePort === port.container &&
          entry.type === port.protocol &&
          entry.publicPort !== null &&
          entry.publicPort >= 1024 &&
          (mapping.host_ip === undefined || entry.ip === mapping.host_ip),
      );
    if (!binding) throw new Error("Automatic application port could not be verified");
    ports[port.index] = { ...mapping, published: String(binding.publicPort) };
  }
  return stringify(doc, { lineWidth: 0 });
}
