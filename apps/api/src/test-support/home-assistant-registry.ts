import type { Server } from "node:http";
import { WebSocketServer } from "ws";

/** Disposable protocol fixture, never part of production data or a host connection. */
export function addRegistryFixture(
  server: Server,
  registry: { devices: unknown[]; entities: unknown[]; areas: unknown[] },
  options: { token: string; denied?: boolean; onCommand?: (type: string) => void },
) {
  const sockets = new WebSocketServer({ server, path: "/api/websocket" });
  sockets.on("connection", (ws) => {
    let authenticated = false;
    ws.send(JSON.stringify({ type: "auth_required" }));
    ws.on("message", (data) => {
      const msg = JSON.parse(
        (Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data
        ).toString(),
      ) as {
        type: string;
        access_token?: string;
        id?: number;
      };
      if (!authenticated) {
        authenticated = msg.type === "auth" && msg.access_token === options.token;
        ws.send(JSON.stringify({ type: authenticated ? "auth_ok" : "auth_invalid" }));
        if (!authenticated) ws.close();
        return;
      }
      options.onCommand?.(msg.type);
      const result = {
        "config/device_registry/list": registry.devices,
        "config/entity_registry/list": registry.entities,
        "config/area_registry/list": registry.areas,
      }[msg.type];
      ws.send(
        JSON.stringify({
          id: msg.id,
          type: "result",
          success: !options.denied && result !== undefined,
          result,
        }),
      );
    });
  });
  return () => {
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
  };
}
