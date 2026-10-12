import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { addRegistryFixture } from "../../test-support/home-assistant-registry.ts";
import { collectHomeAssistantStates, type AdapterContext } from "./adapters.ts";
import { deviceBrand, homeAssistantRegistry } from "./home-assistant-registry.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(denied = false) {
  const commands: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/services"
          ? [{ domain: "light", services: { toggle: {} } }]
          : [
              {
                entity_id: "light.allowed",
                state: "on",
                attributes: { friendly_name: "Lamp", icon: "mdi:lamp" },
              },
              {
                entity_id: "sensor.hidden",
                state: "42",
                attributes: { friendly_name: "Private sensor" },
              },
            ],
      ),
    );
  });
  const closeRegistry = addRegistryFixture(
    server,
    {
      devices: [
        {
          id: "device-1",
          name: "Living room lamp",
          manufacturer: "Signify",
          model: "LCA001",
          area_id: "room",
          serial_number: "private-serial",
          identifiers: [["secret", "private-id"]],
        },
      ],
      entities: [
        { entity_id: "light.allowed", device_id: "device-1", original_icon: "mdi:lightbulb" },
        { entity_id: "sensor.hidden", device_id: "device-1", entity_category: "diagnostic" },
      ],
      areas: [{ id: "room", name: "Living room", picture: "/secret-camera" }],
    },
    { token: "fixture-token", denied, onCommand: (type) => commands.push(type) },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    closeRegistry();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const context: AdapterContext = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secret: "fixture-token",
    username: null,
    options: { entities: ["light.allowed"], controlEntities: ["light.allowed"] },
    signal: new AbortController().signal,
    agent: {
      containerState: () => Promise.resolve(null),
      postgresStats: () => Promise.reject(new Error("unused")),
    },
  };
  return { context, commands };
}

it("reads real registry commands, joins device/room metadata and never exposes hidden entities or registry secrets", async () => {
  const { context, commands } = await fixture();
  const result = await collectHomeAssistantStates(context);
  expect(result.registry).toBe("ok");
  expect(result.entities).toHaveLength(1);
  expect(result.entities[0]).toMatchObject({
    entityId: "light.allowed",
    icon: "mdi:lamp",
    area: "Living room",
    device: { id: "device-1", manufacturer: "Signify", model: "LCA001", brand: "hue" },
  });
  for (const secret of [
    "fixture-token",
    "private-serial",
    "private-id",
    "secret-camera",
    "sensor.hidden",
  ])
    expect(JSON.stringify(result)).not.toContain(secret);
  await collectHomeAssistantStates(context);
  expect(commands).toEqual([
    "config/device_registry/list",
    "config/entity_registry/list",
    "config/area_registry/list",
  ]);
});

it("keeps states and allowed controls usable when registry permission is denied", async () => {
  const { context } = await fixture(true);
  const result = await collectHomeAssistantStates(context);
  expect(result).toMatchObject({ registry: "unavailable", controllable: ["light.allowed"] });
  expect(result.entities[0]?.device).toBeNull();
});

it("rejects metadata addresses before opening a registry socket and distinguishes Tapo models", async () => {
  const { context, commands } = await fixture();
  const result = await homeAssistantRegistry({
    ...context,
    baseUrl: "http://metadata.invalid",
    resolve: () => Promise.resolve([{ address: "169.254.169.254", family: 4 }]),
  });
  expect(result.status).toBe("unavailable");
  expect(commands).toEqual([]);
  expect(deviceBrand("TP-Link", "Tapo P110")).toBe("tapo");
  expect(deviceBrand("Unknown manufacturer", "Hue lamp")).toBeNull();
});
