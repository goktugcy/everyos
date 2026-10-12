export const HOME_ASSISTANT_SIMPLE_SERVICES = [
  "toggle",
  "turn_on",
  "turn_off",
  "open_cover",
  "close_cover",
  "stop_cover",
  "press",
  "lock",
  "unlock",
  "trigger",
  "start",
  "pause",
  "stop",
  "return_to_base",
  "media_play",
  "media_pause",
] as const;

export type HomeAssistantSimpleService = (typeof HOME_ASSISTANT_SIMPLE_SERVICES)[number];
export type HomeAssistantService =
  HomeAssistantSimpleService | "set_temperature" | "set_hvac_mode" | "set_value" | "select_option";

/** Fixed device actions; arbitrary Home Assistant services are never exposed. */
export const HOME_ASSISTANT_SERVICES: Readonly<Record<string, readonly HomeAssistantService[]>> = {
  switch: ["toggle", "turn_on", "turn_off"],
  light: ["toggle", "turn_on", "turn_off"],
  input_boolean: ["toggle", "turn_on", "turn_off"],
  fan: ["toggle", "turn_on", "turn_off"],
  humidifier: ["toggle", "turn_on", "turn_off"],
  automation: ["toggle", "turn_on", "turn_off", "trigger"],
  cover: ["open_cover", "close_cover", "stop_cover"],
  script: ["turn_on", "turn_off"],
  scene: ["turn_on"],
  button: ["press"],
  input_button: ["press"],
  lock: ["lock", "unlock"],
  climate: ["turn_on", "turn_off", "set_temperature", "set_hvac_mode"],
  vacuum: ["start", "pause", "stop", "return_to_base"],
  media_player: ["turn_on", "turn_off", "media_play", "media_pause"],
  number: ["set_value"],
  input_number: ["set_value"],
  select: ["select_option"],
  input_select: ["select_option"],
};

type Target = { entityId: string };
export type HomeAssistantAction = Target &
  (
    | { service: HomeAssistantSimpleService; confirm?: true | undefined }
    | { service: "set_temperature"; temperature: number }
    | { service: "set_hvac_mode"; hvacMode: string }
    | { service: "set_value"; value: number }
    | { service: "select_option"; option: string }
  );

export const HOME_ASSISTANT_BRANDS = [
  "hue",
  "aqara",
  "ikea",
  "shelly",
  "sonoff",
  "xiaomi",
  "tuya",
  "tapo",
  "tplink",
  "esphome",
  "samsung",
  "lg_thinq",
  "bosch_shc",
  "netatmo",
  "nest",
  "ring",
  "reolink",
  "ubiquiti",
  "roborock",
  "ecovacs",
  "sonos",
  "nanoleaf",
  "govee",
  "tado",
] as const;
export type HomeAssistantBrand = (typeof HOME_ASSISTANT_BRANDS)[number];

export interface HomeAssistantDevice {
  id: string;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  brand: HomeAssistantBrand | null;
}

export interface HomeAssistantEntity {
  entityId: string;
  name: string | null;
  state: string;
  unit: string | null;
  deviceClass: string | null;
  device: HomeAssistantDevice | null;
  area: string | null;
  icon: string | null;
  category: string | null;
  lastChanged: number | null;
  actions: HomeAssistantService[];
  currentTemperature: number | null;
  targetTemperature: number | null;
  min: number | null;
  max: number | null;
  step: number | null;
  options: string[];
}

export interface HomeAssistantStates {
  source: "host";
  registry: "ok" | "unavailable";
  entities: HomeAssistantEntity[];
  controllable: string[];
}
