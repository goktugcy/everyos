import { createHash } from "node:crypto";
import WebSocket from "ws";
import type { HomeAssistantBrand, HomeAssistantDevice } from "@everyos/shared";
import type { AdapterContext } from "./adapters.ts";
import { IntegrationHttpError, joinUrl, resolveIntegrationAddress } from "./http.ts";

type Json = Record<string, unknown>;
const object = (v: unknown): Json =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const text = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, 128) : null;

// Manufacturer aliases, not integration platforms: a Zigbee bridge is not the device's brand.
const BRANDS: ReadonlyArray<[RegExp, HomeAssistantBrand]> = [
  [/^(philips|signify|philips hue)$/i, "hue"],
  [/^(aqara|lumi|lumi united technology.*)$/i, "aqara"],
  [/^ikea.*$/i, "ikea"],
  [/^(shelly|allterco.*)$/i, "shelly"],
  [/^(sonoff|itead.*)$/i, "sonoff"],
  [/^xiaomi.*$/i, "xiaomi"],
  [/^tuya.*$/i, "tuya"],
  [/^tapo$/i, "tapo"],
  [/^tp[- ]?link.*$/i, "tplink"],
  [/^esphome$/i, "esphome"],
  [/^samsung.*$/i, "samsung"],
  [/^(lg|lg electronics.*)$/i, "lg_thinq"],
  [/^bosch.*$/i, "bosch_shc"],
  [/^netatmo.*$/i, "netatmo"],
  [/^nest.*$/i, "nest"],
  [/^ring.*$/i, "ring"],
  [/^reolink.*$/i, "reolink"],
  [/^ubiquiti.*$/i, "ubiquiti"],
  [/^roborock.*$/i, "roborock"],
  [/^ecovacs.*$/i, "ecovacs"],
  [/^sonos.*$/i, "sonos"],
  [/^nanoleaf.*$/i, "nanoleaf"],
  [/^govee.*$/i, "govee"],
  [/^tado.*$/i, "tado"],
];

export function deviceBrand(
  manufacturer: string | null,
  model: string | null,
): HomeAssistantBrand | null {
  if (!manufacturer) return null;
  // TP-Link's Tapo family has its own branding; preserve the reported manufacturer/model text.
  if (/^tp[- ]?link/i.test(manufacturer) && /^tapo\b/i.test(model ?? "")) return "tapo";
  return BRANDS.find(([pattern]) => pattern.test(manufacturer.trim()))?.[1] ?? null;
}

export interface RegistryMetadata {
  device: HomeAssistantDevice | null;
  area: string | null;
  icon: string | null;
  category: string | null;
}
interface Registry {
  status: "ok" | "unavailable";
  entities: Map<string, RegistryMetadata>;
}
const unavailable = (): Registry => ({ status: "unavailable", entities: new Map() });

function sanitize(results: unknown[]): Registry {
  const [devices, entities, areas] = results;
  if (![devices, entities, areas].every((v) => Array.isArray(v) && v.length <= 10_000))
    throw new IntegrationHttpError("invalid", "Invalid Home Assistant registry");
  const areaMap = new Map(
    (areas as unknown[])
      .map(object)
      .filter((a) => text(a.id) !== null)
      .map((a) => [text(a.id), text(a.name)]),
  );
  const deviceMap = new Map(
    (devices as unknown[])
      .map(object)
      .filter((d) => text(d.id) !== null)
      .map((d) => {
        const manufacturer = text(d.manufacturer),
          model = text(d.model);
        return [
          text(d.id),
          {
            device: {
              id: text(d.id) ?? "",
              name: text(d.name_by_user) ?? text(d.name),
              manufacturer,
              model,
              brand: deviceBrand(manufacturer, model),
            },
            area: areaMap.get(text(d.area_id)) ?? null,
          },
        ] as const;
      }),
  );
  return {
    status: "ok",
    entities: new Map(
      (entities as unknown[])
        .map(object)
        .filter((e) => text(e.entity_id))
        .map((e) => {
          const device = deviceMap.get(text(e.device_id));
          return [
            text(e.entity_id)!,
            {
              device: device?.device ?? null,
              area: areaMap.get(text(e.area_id)) ?? device?.area ?? null,
              icon: text(e.icon) ?? text(e.original_icon),
              category: text(e.entity_category),
            },
          ];
        }),
    ),
  };
}

/** A short read-only session: fixed registry commands, pinned DNS, no redirects or subscriptions. */
async function readRegistry(context: AdapterContext): Promise<Registry> {
  if (!context.baseUrl || !context.secret) return unavailable();
  const target = new URL(joinUrl(context.baseUrl, "/api/websocket"));
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
    throw new IntegrationHttpError("invalid", "Unsupported URL");
  const pinned = await resolveIntegrationAddress(target, context.resolve);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(6_000)]);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Registry request aborted"));
      return;
    }
    const ws = new WebSocket(target, {
      followRedirects: false,
      handshakeTimeout: 6_000,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
      family: pinned.family,
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
    });
    let done = false,
      authenticated = false,
      bytes = 0;
    const results = new Map<number, unknown>();
    const finish = (error?: Error, result?: Registry) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", aborted);
      ws.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const aborted = () => finish(new Error("Registry request aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    ws.on("error", () => finish(new Error("Registry connection failed")));
    ws.on("close", () => finish(new Error("Registry connection closed")));
    ws.on("message", (data, binary) => {
      try {
        const payload = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        bytes += payload.length;
        if (binary || bytes > 48 * 1024 * 1024) throw new Error("Invalid registry message");
        const message = object(JSON.parse(payload.toString()));
        if (message.type === "auth_required" && !authenticated) {
          ws.send(JSON.stringify({ type: "auth", access_token: context.secret }));
        } else if (message.type === "auth_invalid") {
          throw new Error("Registry credentials rejected");
        } else if (message.type === "auth_ok" && !authenticated) {
          authenticated = true;
          ["device", "entity", "area"].forEach((kind, index) =>
            ws.send(JSON.stringify({ id: index + 1, type: `config/${kind}_registry/list` })),
          );
        } else if (
          authenticated &&
          message.type === "result" &&
          typeof message.id === "number" &&
          [1, 2, 3].includes(message.id)
        ) {
          if (message.success !== true) throw new Error("Registry read denied");
          results.set(message.id, message.result);
          if (results.size === 3)
            finish(undefined, sanitize([results.get(1), results.get(2), results.get(3)]));
        }
      } catch {
        finish(new Error("Registry response unavailable"));
      }
    });
  });
}

// Cache only sanitized metadata, keyed by a credential fingerprint. Scope filtering happens on every read.
const cache = new Map<string, { expires: number; result: Promise<Registry> }>();
export async function homeAssistantRegistry(context: AdapterContext): Promise<Registry> {
  const key = createHash("sha256")
    .update(JSON.stringify([context.baseUrl, context.secret]))
    .digest("hex");
  const old = cache.get(key);
  if (old && old.expires > Date.now()) return old.result;
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  const entry = {
    expires: Date.now() + 60_000,
    result: readRegistry(context).catch(() => unavailable()),
  };
  cache.set(key, entry);
  const result = await entry.result;
  if (result.status === "unavailable") entry.expires = Date.now() + 15_000;
  return result;
}
