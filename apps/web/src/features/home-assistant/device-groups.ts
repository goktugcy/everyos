import type { HomeAssistantEntity } from "@everyos/shared";

export interface DeviceGroup {
  id: string;
  name: string;
  primary: HomeAssistantEntity;
  entities: HomeAssistantEntity[];
}

function priority(entity: HomeAssistantEntity) {
  if (entity.category) return 3;
  if (entity.actions.length > 0) return 0;
  if (entity.deviceClass === "temperature") return 1;
  return 2;
}

/** Group only entities already allowed by the server; hidden siblings never become device details. */
export function deviceGroups(
  entities: HomeAssistantEntity[],
  view: "devices" | "entities",
): DeviceGroup[] {
  const groups = new Map<string, HomeAssistantEntity[]>();
  for (const entity of entities) {
    const id =
      view === "devices" && entity.device
        ? `device:${entity.device.id}`
        : `entity:${entity.entityId}`;
    const list = groups.get(id) ?? [];
    list.push(entity);
    groups.set(id, list);
  }
  return [...groups.entries()]
    .map(([id, list]) => {
      const sorted = [...list].sort(
        (a, b) =>
          priority(a) - priority(b) || (a.name ?? a.entityId).localeCompare(b.name ?? b.entityId),
      );
      const primary = sorted[0]!;
      return {
        id,
        name:
          view === "devices"
            ? (primary.device?.name ?? primary.name ?? primary.entityId)
            : (primary.name ?? primary.entityId),
        primary,
        entities: sorted,
      };
    })
    .sort(
      (a, b) =>
        (view === "devices" ? priority(a.primary) - priority(b.primary) : 0) ||
        a.name.localeCompare(b.name),
    );
}
