import type { HomeAssistantEntity } from "@everyos/shared";
import {
  Battery,
  Blinds,
  Camera,
  DoorOpen,
  Droplets,
  Fan,
  Gauge,
  Home,
  Lightbulb,
  LockKeyhole,
  Plug,
  Power,
  Radio,
  Shield,
  Smartphone,
  Thermometer,
  Tv,
  Wind,
  Zap,
} from "lucide-react";
import { useState } from "react";

const ICONS = {
  light: Lightbulb,
  fan: Fan,
  cover: Blinds,
  lock: LockKeyhole,
  climate: Thermometer,
  switch: Plug,
  humidifier: Droplets,
  vacuum: Wind,
  media_player: Tv,
  camera: Camera,
  person: Smartphone,
  automation: Zap,
  scene: Lightbulb,
  script: Zap,
  button: Power,
  input_button: Power,
  input_boolean: Power,
  valve: Droplets,
  water_heater: Thermometer,
  siren: Radio,
  remote: Radio,
  lawn_mower: Wind,
  weather: Wind,
};
const CLASSES = {
  temperature: Thermometer,
  humidity: Droplets,
  moisture: Droplets,
  battery: Battery,
  power: Zap,
  energy: Zap,
  current: Zap,
  voltage: Zap,
  pressure: Gauge,
  motion: Radio,
  occupancy: Radio,
  door: DoorOpen,
  window: DoorOpen,
  opening: DoorOpen,
  safety: Shield,
  smoke: Shield,
  gas: Shield,
  carbon_monoxide: Shield,
};
const MDI = {
  "mdi:lightbulb": Lightbulb,
  "mdi:ceiling-light": Lightbulb,
  "mdi:lamp": Lightbulb,
  "mdi:fan": Fan,
  "mdi:thermometer": Thermometer,
  "mdi:water-percent": Droplets,
  "mdi:battery": Battery,
  "mdi:power-plug": Plug,
  "mdi:power-socket-eu": Plug,
  "mdi:blinds": Blinds,
  "mdi:window-shutter": Blinds,
  "mdi:lock": LockKeyhole,
  "mdi:television": Tv,
  "mdi:camera": Camera,
  "mdi:motion-sensor": Radio,
};

export function DeviceSymbol({
  entity,
  className = "size-6",
}: {
  entity: HomeAssistantEntity;
  className?: string;
}) {
  const domain = entity.entityId.split(".")[0]!;
  const Icon =
    entity.icon && Object.hasOwn(MDI, entity.icon)
      ? MDI[entity.icon as keyof typeof MDI]
      : entity.deviceClass && Object.hasOwn(CLASSES, entity.deviceClass)
        ? CLASSES[entity.deviceClass as keyof typeof CLASSES]
        : Object.hasOwn(ICONS, domain)
          ? ICONS[domain as keyof typeof ICONS]
          : Home;
  return <Icon className={className} aria-hidden />;
}

export function BrandIcon({
  integrationId,
  entity,
}: {
  integrationId: string;
  entity: HomeAssistantEntity;
}) {
  const [failed, setFailed] = useState(false);
  const brand = entity.device?.brand;
  return brand && !failed ? (
    <img
      src={`/api/integrations/${integrationId}/brand/${brand}`}
      alt=""
      className="size-5 shrink-0 rounded object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : null;
}
