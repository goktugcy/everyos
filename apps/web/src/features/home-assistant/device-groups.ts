import type { HomeAssistantEntity } from "@everyos/shared";

export interface DeviceGroup {
  id: string;
  name: string;
  primary: HomeAssistantEntity;
  entities: HomeAssistantEntity[];
}

function priority(entity: HomeAssistantEntity) {
  if (entity.category) return 3;
  if (entity.actions.length > 0 || Boolean(entity.controls?.length)) return 0;
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
        ? `device:${JSON.stringify([entity.device.id, entity.area])}`
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

/** A physical device may expose entities assigned to different areas. Keep those rooms separate. */
export function roomGroups(
  groups: DeviceGroup[],
): Array<{ area: string | null; groups: DeviceGroup[] }> {
  const rooms = new Map<string | null, DeviceGroup[]>();
  for (const group of groups) {
    const area = group.primary.area;
    const room = rooms.get(area) ?? [];
    room.push(group);
    rooms.set(area, room);
  }
  return [...rooms]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([area, groups]) => ({ area, groups }));
}
