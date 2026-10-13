/** Fixed service/field pairs. Remote service descriptions never define executable actions. */
export const HOME_ASSISTANT_CONTROL_FIELDS = {
  brightness: { service: "turn_on", field: "brightness_pct" },
  color: { service: "turn_on", field: "rgb_color" },
  colorTemperature: { service: "turn_on", field: "color_temp_kelvin" },
  white: { service: "turn_on", field: "white" },
  effect: { service: "turn_on", field: "effect" },
  flash: { service: "turn_on", field: "flash" },
  transition: { service: "turn_on", field: "transition" },
  percentage: { service: "set_percentage", field: "percentage" },
  fanPreset: { service: "set_preset_mode", field: "preset_mode" },
  oscillation: { service: "oscillate", field: "oscillating" },
  direction: { service: "set_direction", field: "direction" },
  position: { service: "set_cover_position", field: "position" },
  tilt: { service: "set_cover_tilt_position", field: "tilt_position" },
  valvePosition: { service: "set_valve_position", field: "position" },
  humidity: { service: "set_humidity", field: "humidity" },
  temperatureRange: { service: "set_temperature", field: "temperature_range" },
  humidifierMode: { service: "set_mode", field: "mode" },
  climateFan: { service: "set_fan_mode", field: "fan_mode" },
  climatePreset: { service: "set_preset_mode", field: "preset_mode" },
  swing: { service: "set_swing_mode", field: "swing_mode" },
  swingHorizontal: { service: "set_swing_horizontal_mode", field: "swing_horizontal_mode" },
  volume: { service: "volume_set", field: "volume_level" },
  muted: { service: "volume_mute", field: "is_volume_muted" },
  source: { service: "select_source", field: "source" },
  soundMode: { service: "select_sound_mode", field: "sound_mode" },
  shuffle: { service: "shuffle_set", field: "shuffle" },
  repeat: { service: "repeat_set", field: "repeat" },
  seek: { service: "media_seek", field: "seek_position" },
  vacuumFan: { service: "set_fan_speed", field: "fan_speed" },
  waterHeaterMode: { service: "set_operation_mode", field: "operation_mode" },
  away: { service: "set_away_mode", field: "away_mode" },
  sirenTone: { service: "turn_on", field: "tone" },
  sirenVolume: { service: "turn_on", field: "volume_level" },
  sirenDuration: { service: "turn_on", field: "duration" },
} as const;

export type HomeAssistantControlId = keyof typeof HOME_ASSISTANT_CONTROL_FIELDS;
export type HomeAssistantControlValue =
  number | string | boolean | [number, number, number] | [number, number];
type Control = { id: HomeAssistantControlId };
export type HomeAssistantControl = Control &
  (
    | {
        kind: "number";
        min: number;
        max: number;
        step: number;
        value: number | null;
        unit: string | null;
      }
    | { kind: "choice"; options: Array<string | number>; value: string | number | null }
    | { kind: "boolean"; value: boolean | null }
    | { kind: "color"; value: [number, number, number] | null }
    | {
        kind: "temperatureRange";
        min: number;
        max: number;
        step: number;
        value: [number, number] | null;
      }
  );
