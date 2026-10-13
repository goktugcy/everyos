import type { TFunction } from "i18next";
import type { HomeAssistantEntity } from "@everyos/shared";

const STATES = [
  "on",
  "off",
  "open",
  "closed",
  "opening",
  "closing",
  "locked",
  "unlocked",
  "locking",
  "unlocking",
  "unavailable",
  "unknown",
  "home",
  "not_home",
  "heat",
  "cool",
  "auto",
  "idle",
  "heat_cool",
  "dry",
  "fan_only",
  "playing",
  "paused",
  "docked",
  "cleaning",
  "jammed",
] as const;
const DOMAINS = [
  "switch",
  "light",
  "input_boolean",
  "fan",
  "humidifier",
  "automation",
  "cover",
  "script",
  "scene",
  "button",
  "input_button",
  "lock",
  "climate",
  "vacuum",
  "media_player",
  "number",
  "input_number",
  "select",
  "input_select",
  "sensor",
  "binary_sensor",
  "person",
  "weather",
  "camera",
  "valve",
  "water_heater",
  "siren",
  "remote",
  "lawn_mower",
] as const;

export function entityValue(t: TFunction, entity: HomeAssistantEntity): string {
  const known = STATES.find((state) => state === entity.state);
  if (known) return t(`homeAssistant.states.${known}`);
  return entity.unit ? `${entity.state} ${entity.unit}` : entity.state;
}

export function domainLabel(t: TFunction, domain: string): string {
  const known = DOMAINS.find((value) => value === domain);
  return known ? t(`homeAssistant.domains.${known}`) : domain;
}
