import {
  HOME_ASSISTANT_CONTROL_FIELDS,
  HOME_ASSISTANT_SERVICES,
  type HomeAssistantControl,
  type HomeAssistantControlId,
  type HomeAssistantEntity,
  type HomeAssistantService,
} from "@everyos/shared";

type Json = Record<string, unknown>;
const object = (v: unknown): Json =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const text = (v: unknown, max = 128): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;
const number = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const choices = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 256),
        ),
      ].slice(0, 256)
    : [];

// Home Assistant core entity feature enums. A domain-wide service is not a device capability.
const FEATURES: Readonly<Record<string, Partial<Record<HomeAssistantService, number>>>> = {
  fan: {
    turn_on: 32,
    turn_off: 16,
    toggle: 48,
    set_percentage: 1,
    oscillate: 2,
    set_direction: 4,
    set_preset_mode: 8,
  },
  cover: {
    open_cover: 1,
    close_cover: 2,
    set_cover_position: 4,
    stop_cover: 8,
    open_cover_tilt: 16,
    close_cover_tilt: 32,
    stop_cover_tilt: 64,
    set_cover_tilt_position: 128,
  },
  climate: {
    set_temperature: 1,
    set_humidity: 4,
    set_fan_mode: 8,
    set_preset_mode: 16,
    set_swing_mode: 32,
    turn_off: 128,
    turn_on: 256,
    set_swing_horizontal_mode: 512,
  },
  humidifier: { set_mode: 1 },
  media_player: {
    media_pause: 1,
    media_seek: 2,
    volume_set: 4,
    volume_mute: 8,
    media_previous_track: 16,
    media_next_track: 32,
    turn_on: 128,
    turn_off: 256,
    volume_up: 1024,
    volume_down: 1024,
    select_source: 2048,
    media_stop: 4096,
    media_play: 16384,
    shuffle_set: 32768,
    select_sound_mode: 65536,
    repeat_set: 262144,
  },
  vacuum: {
    start: 8192,
    pause: 4,
    stop: 8,
    return_to_base: 16,
    set_fan_speed: 32,
    locate: 512,
    clean_spot: 1024,
  },
  valve: { open_valve: 1, close_valve: 2, set_valve_position: 4, stop_valve: 8 },
  water_heater: {
    set_temperature: 1,
    set_operation_mode: 2,
    set_away_mode: 4,
    turn_on: 8,
    turn_off: 8,
  },
  siren: { turn_on: 1, turn_off: 2 },
  lawn_mower: { start_mowing: 1, pause: 2, dock: 4, stop: 8 },
  lock: { open: 1 },
};

export function homeAssistantEntity(
  raw: Json,
  services: Map<string, Set<string>>,
): HomeAssistantEntity {
  const a = object(raw.attributes);
  const entityId = text(raw.entity_id, 128) ?? "";
  const domain = entityId.split(".")[0]!;
  const featureValue = number(a.supported_features);
  const features = featureValue ?? 0;
  const has = (flag: number) => (features & flag) === flag;
  const temperatureDomain = domain === "climate" || domain === "water_heater";
  const min = number(temperatureDomain ? a.min_temp : a.min);
  const max = number(temperatureDomain ? a.max_temp : a.max);
  const options = choices(domain === "climate" ? a.hvac_modes : a.options);
  const unit = text(temperatureDomain ? a.temperature_unit : a.unit_of_measurement, 16);
  const supports = (service: HomeAssistantService) => {
    if (!services.get(domain)?.has(service)) return false;
    if (domain === "climate" && service === "set_temperature") return has(1) || has(2);
    const flag = FEATURES[domain]?.[service];
    // Preserve old basic controls on integrations omitting feature flags; new settings fail closed.
    if (flag !== undefined && !has(flag)) {
      if (featureValue === null && ["fan", "media_player", "vacuum"].includes(domain))
        return [
          "toggle",
          "turn_on",
          "turn_off",
          "media_play",
          "media_pause",
          "start",
          "pause",
          "stop",
          "return_to_base",
        ].includes(service);
      return false;
    }
    return true;
  };
  const controls: HomeAssistantControl[] = [];
  const allowed = (id: HomeAssistantControlId) =>
    supports(HOME_ASSISTANT_CONTROL_FIELDS[id].service);
  const numeric = (
    id: HomeAssistantControlId,
    value: unknown,
    low: number | null,
    high: number | null,
    step = 1,
    unit: string | null = null,
  ) => {
    if (
      !allowed(id) ||
      low === null ||
      high === null ||
      low > high ||
      !Number.isFinite(low) ||
      !Number.isFinite(high)
    )
      return;
    const current = number(value);
    controls.push({
      id,
      kind: "number",
      min: low,
      max: high,
      step: step > 0 && Number.isFinite(step) ? step : 1,
      unit,
      value: current !== null && current >= low && current <= high ? current : null,
    });
  };
  const selection = (id: HomeAssistantControlId, value: unknown, list: unknown) => {
    const options: Array<string | number> =
      id === "sirenTone" && Array.isArray(list)
        ? list
            .filter(
              (value): value is string | number =>
                (typeof value === "string" && value.length > 0 && value.length <= 256) ||
                (typeof value === "number" && Number.isSafeInteger(value)),
            )
            .slice(0, 256)
        : choices(list);
    const current = typeof value === "number" ? number(value) : text(value, 256);
    if (allowed(id) && options.length)
      controls.push({
        id,
        kind: "choice",
        options,
        value: current !== null && options.includes(current) ? current : null,
      });
  };
  const boolean = (id: HomeAssistantControlId, value: unknown) => {
    if (allowed(id))
      controls.push({ id, kind: "boolean", value: typeof value === "boolean" ? value : null });
  };
  if (domain === "light") {
    const modes = choices(a.supported_color_modes);
    const colors = ["hs", "xy", "rgb", "rgbw", "rgbww"];
    if (modes.some((mode) => ["brightness", "color_temp", "white", ...colors].includes(mode)))
      numeric(
        "brightness",
        number(a.brightness) === null ? null : (number(a.brightness)! / 255) * 100,
        0,
        100,
        1,
        "%",
      );
    if (allowed("color") && modes.some((mode) => colors.includes(mode))) {
      const rgb = a.rgb_color;
      controls.push({
        id: "color",
        kind: "color",
        value:
          Array.isArray(rgb) &&
          rgb.length === 3 &&
          rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
            ? (rgb as [number, number, number])
            : null,
      });
    }
    if (modes.includes("color_temp")) {
      const low =
        number(a.min_color_temp_kelvin) ??
        (number(a.max_mireds) && Math.ceil(1e6 / number(a.max_mireds)!));
      const high =
        number(a.max_color_temp_kelvin) ??
        (number(a.min_mireds) && Math.floor(1e6 / number(a.min_mireds)!));
      numeric(
        "colorTemperature",
        a.color_temp_kelvin ?? (number(a.color_temp) && 1e6 / number(a.color_temp)!),
        low,
        high,
        1,
        "K",
      );
    }
    if (modes.includes("white")) numeric("white", null, 0, 255);
    if (has(4)) selection("effect", a.effect, a.effect_list);
    if (has(8)) selection("flash", null, ["short", "long"]);
    if (has(32)) numeric("transition", null, 0, 300, 0.1, "s");
  } else if (domain === "fan") {
    numeric("percentage", a.percentage, 0, 100, number(a.percentage_step) ?? 1, "%");
    selection("fanPreset", a.preset_mode, a.preset_modes);
    boolean("oscillation", a.oscillating);
    selection("direction", a.direction, ["forward", "reverse"]);
  } else if (domain === "cover") {
    numeric("position", a.current_position, 0, 100, 1, "%");
    numeric("tilt", a.current_tilt_position, 0, 100, 1, "%");
  } else if (domain === "valve") {
    numeric("valvePosition", a.current_position, 0, 100, 1, "%");
  } else if (domain === "climate") {
    if (supports("set_temperature") && has(2) && min !== null && max !== null && min <= max) {
      const low = number(a.target_temp_low),
        high = number(a.target_temp_high);
      controls.push({
        id: "temperatureRange",
        kind: "temperatureRange",
        min,
        max,
        step: number(a.target_temp_step) ?? 0.5,
        value:
          low !== null && high !== null && low >= min && high <= max && low <= high
            ? [low, high]
            : null,
      });
    }
    numeric(
      "humidity",
      a.humidity,
      number(a.min_humidity) ?? 0,
      number(a.max_humidity) ?? 100,
      1,
      "%",
    );
    selection("climateFan", a.fan_mode, a.fan_modes);
    selection("climatePreset", a.preset_mode, a.preset_modes);
    selection("swing", a.swing_mode, a.swing_modes);
    selection("swingHorizontal", a.swing_horizontal_mode, a.swing_horizontal_modes);
  } else if (domain === "humidifier") {
    numeric(
      "humidity",
      a.humidity,
      number(a.min_humidity) ?? 0,
      number(a.max_humidity) ?? 100,
      1,
      "%",
    );
    selection("humidifierMode", a.mode, a.available_modes);
  } else if (domain === "media_player") {
    numeric("volume", a.volume_level, 0, 1, 0.01);
    numeric("seek", a.media_position, 0, number(a.media_duration), 1, "s");
    boolean("muted", a.is_volume_muted);
    boolean("shuffle", a.shuffle);
    selection("source", a.source, a.source_list);
    selection("soundMode", a.sound_mode, a.sound_mode_list);
    selection("repeat", a.repeat, ["off", "all", "one"]);
  } else if (domain === "vacuum") {
    selection("vacuumFan", a.fan_speed, a.fan_speed_list);
  } else if (domain === "water_heater") {
    selection("waterHeaterMode", a.operation_mode, a.operation_list);
    boolean("away", a.away_mode === "on" ? true : a.away_mode === "off" ? false : a.away_mode);
  } else if (domain === "siren" && supports("turn_on")) {
    if (has(4)) selection("sirenTone", null, a.available_tones);
    if (has(8)) numeric("sirenVolume", a.volume_level, 0, 1, 0.05);
    if (has(16)) numeric("sirenDuration", null, 1, 3600, 1, "s");
  }
  const actions = (
    Object.hasOwn(HOME_ASSISTANT_SERVICES, domain) ? (HOME_ASSISTANT_SERVICES[domain] ?? []) : []
  ).filter((service) => {
    if (!supports(service)) return false;
    if (service === "set_temperature")
      return min !== null && max !== null && min <= max && (domain !== "climate" || has(1));
    if (service === "set_value") return min !== null && max !== null && min <= max;
    if (service === "select_option" || service === "set_hvac_mode") return options.length > 0;
    const settings = Object.entries(HOME_ASSISTANT_CONTROL_FIELDS).filter(
      ([, spec]) => spec.service === service,
    );
    return (
      settings.length === 0 ||
      ["turn_on"].includes(service) ||
      controls.some((c) => settings.some(([id]) => c.id === id))
    );
  });
  const changed = Date.parse(text(raw.last_changed, 64) ?? "");
  return {
    entityId,
    name: text(a.friendly_name),
    state: text(raw.state, 64) ?? "unknown",
    unit,
    deviceClass: text(a.device_class, 32),
    device: null,
    area: null,
    icon: text(a.icon),
    category: null,
    lastChanged: Number.isFinite(changed) ? changed : null,
    actions: [...actions],
    controls,
    currentTemperature: number(a.current_temperature),
    targetTemperature: number(a.temperature),
    min,
    max,
    step: number(temperatureDomain ? a.target_temp_step : a.step),
    options,
  };
}
