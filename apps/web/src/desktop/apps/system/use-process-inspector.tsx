import type { ContainerDetail, ProcessDetail, ProcessList, ServiceDetail } from "@everyos/shared";
import { Info, RefreshCw, RotateCw, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import type { MenuEntry } from "../../menus/menu-model.ts";

type Process = ProcessList["processes"][number];
type Action = "restart" | "stop" | "reload";

export function useProcessInspector(onChanged: () => void) {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const [selected, select] = useState<Process | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inspection = useApiResource<ProcessDetail>(
    selected
      ? `/system/processes/${selected.pid}${selected.startedAt === null ? "" : `?startedAt=${selected.startedAt}`}`
      : null,
    3000,
  );
  // The resource keeps old data while changing paths; never act on the previous selection.
  const detail =
    inspection.data?.pid === selected?.pid &&
    (selected?.startedAt === null || inspection.data?.startedAt === selected?.startedAt) &&
    !inspection.error
      ? inspection.data
      : null;
  const service = useApiResource<ServiceDetail>(
    detail?.serviceUnit && permissions.includes("services:read")
      ? `/services/${encodeURIComponent(detail.serviceUnit)}`
      : null,
    3000,
  );
  const container = useApiResource<ContainerDetail>(
    detail?.containerId && permissions.includes("docker:read")
      ? `/docker/containers/${detail.containerId}`
      : null,
    3000,
  );
  const target =
    detail?.containerId && container.data?.id === detail.containerId && !container.error
      ? {
          kind: "container" as const,
          id: container.data.id,
          name: container.data.name,
          protected: container.data.protected,
          running: container.data.state === "running",
          permission: "docker:manage" as const,
          source: container.data.source,
        }
      : detail?.serviceUnit && service.data?.name === detail.serviceUnit && !service.error
        ? {
            kind: "service" as const,
            id: service.data.name,
            name: service.data.name,
            protected: service.data.protected,
            running: service.data.active === "active",
            permission: "services:manage" as const,
            source: service.data.source,
          }
        : null;
  const available =
    target !== null &&
    target.running &&
    !target.protected &&
    permissions.includes(target.permission) &&
    !pending;
  const act = async (action: Action) => {
    if (!available || !target || (action === "reload" && target.kind !== "service")) return;
    const label = t(`monitor.processes.actions.${action}`);
    if (
      !(await requestConfirm({
        title: t("monitor.processes.confirmTitle", { action: label, name: target.name }),
        body: t("monitor.processes.confirmBody"),
        confirmLabel: label,
        danger: action !== "reload",
      }))
    )
      return;
    setPending(action);
    setError(null);
    setNotice(null);
    try {
      await api(
        target.kind === "service"
          ? `/services/${encodeURIComponent(target.id)}/actions`
          : `/docker/containers/${target.id}/actions`,
        { method: "POST", body: { action } },
      );
      setNotice(t("monitor.processes.submitted", { action: label, name: target.name }));
      inspection.reload();
      service.reload();
      container.reload();
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };
  const actions: Action[] =
    target?.kind === "service" ? ["restart", "reload", "stop"] : ["restart", "stop"];
  const menu = (process: Process): MenuEntry[] => [
    {
      kind: "item",
      id: "details",
      label: t("monitor.processes.details"),
      icon: <Info />,
      onSelect: () => select(process),
    },
    { kind: "separator", id: "manage" },
    ...actions.map((action): MenuEntry => ({
      kind: "item",
      id: action,
      label: t(`monitor.processes.actions.${action}`),
      icon: action === "stop" ? <Square /> : action === "reload" ? <RefreshCw /> : <RotateCw />,
      danger: action === "stop",
      disabled: !available || detail?.pid !== process.pid || detail.startedAt !== process.startedAt,
      ...(target ? { permission: target.permission } : {}),
      onSelect: () => void act(action),
    })),
  ];
  return {
    selected,
    select,
    inspection,
    detail,
    target,
    available,
    pending,
    error,
    notice,
    actions,
    act,
    menu,
    targetError: detail?.containerId ? container.error : detail?.serviceUnit ? service.error : null,
  };
}
