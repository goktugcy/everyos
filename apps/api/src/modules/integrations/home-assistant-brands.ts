import type { HomeAssistantBrand } from "@everyos/shared";
import { requestBytes } from "./http.ts";

const cache = new Map<HomeAssistantBrand, { expires: number; bytes: Promise<Buffer | null> }>();
const BRAND_PATHS: Record<HomeAssistantBrand, string> = {
  hue: "core_integrations/hue",
  aqara: "core_brands/aqara",
  ikea: "core_brands/ikea",
  shelly: "core_integrations/shelly",
  sonoff: "custom_integrations/sonoff",
  xiaomi: "core_brands/xiaomi",
  tuya: "core_integrations/tuya",
  tapo: "core_integrations/tplink_tapo",
  tplink: "core_brands/tplink",
  esphome: "core_integrations/esphome",
  samsung: "core_brands/samsung",
  lg_thinq: "core_brands/lg",
  bosch_shc: "core_brands/bosch",
  netatmo: "core_integrations/netatmo",
  nest: "core_integrations/nest",
  ring: "core_integrations/ring",
  reolink: "core_integrations/reolink",
  ubiquiti: "core_brands/ubiquiti",
  roborock: "core_integrations/roborock",
  ecovacs: "core_integrations/ecovacs",
  sonos: "core_integrations/sonos",
  nanoleaf: "core_integrations/nanoleaf",
  govee: "core_brands/govee",
  tado: "core_integrations/tado",
};

/** Fixed public PNG source, never a device-supplied URL; no Home Assistant credentials are sent. */
export async function homeAssistantBrandIcon(brand: HomeAssistantBrand): Promise<Buffer | null> {
  const existing = cache.get(brand);
  if (existing && existing.expires > Date.now()) return existing.bytes;
  const entry = {
    expires: Date.now() + 24 * 60 * 60_000,
    bytes: requestBytes(
      `https://raw.githubusercontent.com/home-assistant/brands/master/${BRAND_PATHS[brand]}/icon.png`,
      {
        maxBytes: 512 * 1024,
        timeoutMs: 6_000,
      },
    )
      .then(({ bytes }) =>
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? bytes : null,
      )
      .catch(() => null),
  };
  cache.set(brand, entry);
  const bytes = await entry.bytes;
  if (!bytes) entry.expires = Date.now() + 60_000;
  return bytes;
}
