import type { ComponentType } from "react";
import * as ai from "./ai.tsx";
import * as apps from "./apps.tsx";
import * as docker from "./docker.tsx";
import type { WidgetRenderProps } from "./gate.tsx";
import * as system from "./system.tsx";

export type { WidgetRenderProps } from "./gate.tsx";

/**
 * Built-in renderers by manifest id. Only these components ever render
 * widget data: catalogs can reference built-in adapters, never ship code.
 */
export const WIDGET_RENDERERS: Readonly<Record<string, ComponentType<WidgetRenderProps>>> = {
  "system.cpu": system.CpuWidget,
  "system.cpuFrequency": system.CpuFrequencyWidget,
  "system.temperature": system.TemperatureWidget,
  "system.memory": system.MemoryWidget,
  "system.swap": system.SwapWidget,
  "system.diskUsage": system.DiskUsageWidget,
  "system.diskIo": system.DiskIoWidget,
  "system.mounts": system.MountsWidget,
  "system.network": system.NetworkWidget,
  "system.interfaces": system.InterfacesWidget,
  "system.ports": system.PortsWidget,
  "system.connections": system.ConnectionsWidget,
  "system.tailscale": system.TailscaleWidget,
  "system.uptime": system.UptimeWidget,
  "system.load": system.LoadWidget,
  "system.processes": system.ProcessesWidget,
  "system.fans": system.FansWidget,
  "system.sensors": system.SensorsWidget,
  "system.nvme": system.NvmeWidget,
  "system.apt": system.AptWidget,
  "system.alerts": system.AlertsWidget,
  "system.services": system.ServicesWidget,
  "system.timers": system.TimersWidget,
  "raspberryPi.socTemperature": system.SocTemperatureWidget,
  "raspberryPi.throttling": system.ThrottlingWidget,
  "raspberryPi.undervoltage": system.UndervoltageWidget,
  "raspberryPi.model": system.ModelWidget,
  "docker.summary": docker.DockerSummaryWidget,
  "docker.resources": docker.DockerResourcesWidget,
  "docker.app": docker.DockerAppWidget,
  "jellyfin.status": apps.JellyfinStatusWidget,
  "jellyfin.sessions": apps.JellyfinSessionsWidget,
  "jellyfin.library": apps.JellyfinLibraryWidget,
  "immich.status": apps.ImmichStatusWidget,
  "immich.storage": apps.ImmichStorageWidget,
  "immich.statistics": apps.ImmichStatisticsWidget,
  "homeassistant.entities": apps.HomeAssistantEntitiesWidget,
  "homeassistant.automations": apps.HomeAssistantAutomationsWidget,
  "homeassistant.controls": apps.HomeAssistantControlsWidget,
  "uptimekuma.monitors": apps.UptimeKumaMonitorsWidget,
  "uptimekuma.incidents": apps.UptimeKumaIncidentsWidget,
  "nextcloud.status": apps.NextcloudStatusWidget,
  "nextcloud.storage": apps.NextcloudStorageWidget,
  "postgresql.stats": apps.PostgresStatsWidget,
  "ai.chat": ai.AiChatWidget,
};
