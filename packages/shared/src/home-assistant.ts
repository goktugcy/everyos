import type {
  HOME_ASSISTANT_CONTROL_FIELDS,
  HomeAssistantControl,
  HomeAssistantControlId,
  HomeAssistantControlValue,
} from "./home-assistant-controls.ts";

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
  "media_stop",
  "media_next_track",
  "media_previous_track",
  "volume_up",
  "volume_down",
  "open_cover_tilt",
  "close_cover_tilt",
  "stop_cover_tilt",
  "open_valve",
  "close_valve",
  "stop_valve",
  "locate",
  "clean_spot",
  "start_mowing",
  "dock",
  "open",
] as const;

export type HomeAssistantSimpleService = (typeof HOME_ASSISTANT_SIMPLE_SERVICES)[number];
export type HomeAssistantService =
  | HomeAssistantSimpleService
  | "set_temperature"
  | "set_hvac_mode"
  | "set_value"
  | "select_option"
  | (typeof HOME_ASSISTANT_CONTROL_FIELDS)[HomeAssistantControlId]["service"];

/** Fixed device actions; arbitrary Home Assistant services are never exposed. */
export const HOME_ASSISTANT_SERVICES: Readonly<Record<string, readonly HomeAssistantService[]>> = {
  switch: ["toggle", "turn_on", "turn_off"],
  light: ["toggle", "turn_on", "turn_off"],
  input_boolean: ["toggle", "turn_on", "turn_off"],
  fan: [
    "toggle",
    "turn_on",
    "turn_off",
    "set_percentage",
    "set_preset_mode",
    "oscillate",
    "set_direction",
  ],
  humidifier: ["toggle", "turn_on", "turn_off", "set_humidity", "set_mode"],
  automation: ["toggle", "turn_on", "turn_off", "trigger"],
  cover: [
    "open_cover",
    "close_cover",
    "stop_cover",
    "set_cover_position",
    "open_cover_tilt",
    "close_cover_tilt",
    "stop_cover_tilt",
    "set_cover_tilt_position",
  ],
  script: ["turn_on", "turn_off"],
  scene: ["turn_on"],
  button: ["press"],
  input_button: ["press"],
  lock: ["lock", "unlock", "open"],
  climate: [
    "turn_on",
    "turn_off",
    "set_temperature",
    "set_hvac_mode",
    "set_humidity",
    "set_fan_mode",
    "set_preset_mode",
    "set_swing_mode",
    "set_swing_horizontal_mode",
  ],
  vacuum: ["start", "pause", "stop", "return_to_base", "locate", "clean_spot", "set_fan_speed"],
  media_player: [
    "turn_on",
    "turn_off",
    "media_play",
    "media_pause",
    "media_stop",
    "media_next_track",
    "media_previous_track",
    "volume_up",
    "volume_down",
    "volume_set",
    "volume_mute",
    "select_source",
    "select_sound_mode",
    "shuffle_set",
    "repeat_set",
    "media_seek",
  ],
  number: ["set_value"],
  input_number: ["set_value"],
  select: ["select_option"],
  input_select: ["select_option"],
  valve: ["open_valve", "close_valve", "stop_valve", "set_valve_position"],
  water_heater: ["turn_on", "turn_off", "set_temperature", "set_operation_mode", "set_away_mode"],
  siren: ["turn_on", "turn_off"],
  remote: ["toggle", "turn_on", "turn_off"],
  lawn_mower: ["start_mowing", "pause", "dock", "stop"],
};

type Target = { entityId: string };
export type HomeAssistantAction = Target &
  (
    | { service: HomeAssistantSimpleService; confirm?: true | undefined }
    | { service: "set_temperature"; temperature: number }
    | { service: "set_hvac_mode"; hvacMode: string }
    | { service: "set_value"; value: number }
    | { service: "select_option"; option: string }
    | { service: "configure"; control: HomeAssistantControlId; value: HomeAssistantControlValue }
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
  controls: HomeAssistantControl[];
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
