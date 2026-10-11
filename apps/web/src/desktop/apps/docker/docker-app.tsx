import type { DockerStatus } from "@everyos/shared";
import { Tabs } from "radix-ui";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { useLiveDocker, useLiveDockerSubscription } from "../../../features/docker/live-docker.ts";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { useAppStateField } from "../app-context.ts";
import { ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { ContainersTab } from "./containers-tab.tsx";
import { ProjectsTab } from "./projects-tab.tsx";
import { ImagesTab, NetworksTab, VolumesTab } from "./resources-tabs.tsx";

const TABS = ["containers", "projects", "images", "volumes", "networks"] as const;

/** Docker: containers, Compose projects, images, volumes and networks. */
export default function DockerApp() {
  const { t } = useTranslation();
  const [tab, setTab] = useAppStateField("tab", TABS, "containers");
  useLiveDockerSubscription();
  const revision = useLiveDocker((state) => state.revision);
  const status = useApiResource<DockerStatus>("/docker", 60_000);
  const docker = status.data;

  if (docker && !docker.status.available) {
    return (
      <div className="p-4">
        <Alert tone="warning" title={t("docker.tabs.containers")}>
          {t(`system.reasons.${docker.status.reason ?? "not-detected"}`)}
        </Alert>
      </div>
    );
  }

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => setTab(value as (typeof TABS)[number])}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-x-3 border-b border-line px-3 pt-2">
        <Tabs.List aria-label={t("apps.docker")} className="flex gap-1 overflow-x-auto">
          {TABS.map((id) => (
            <Tabs.Trigger
              key={id}
              value={id}
              className="-mb-px whitespace-nowrap rounded-t-everyos-sm border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-fg"
            >
              {t(`docker.tabs.${id}`)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {docker ? (
          <span className="flex items-center gap-2 pb-2 text-xs text-fg-subtle">
            {t("docker.versionLine", {
              version: docker.version ?? "—",
              api: docker.apiVersion ?? "—",
            })}{" "}
            ·{" "}
            {docker.compose.available
              ? t("docker.composeLine", { version: docker.compose.version ?? "—" })
              : t("docker.noCompose")}
            <SimulatedBadge source={docker.source} />
          </span>
        ) : null}
      </div>
      <div className="px-3 empty:hidden">
        <ResourceError error={status.error} />
      </div>
      {TABS.map((id) => (
        <Tabs.Content
          key={id}
          value={id}
          className="@container min-h-0 flex-1 overflow-y-auto outline-none"
        >
          {id === "containers" ? <ContainersTab refreshKey={revision} /> : null}
          {id === "projects" ? <ProjectsTab refreshKey={revision} /> : null}
          {id === "images" ? <ImagesTab refreshKey={revision} /> : null}
          {id === "volumes" ? <VolumesTab refreshKey={revision} /> : null}
          {id === "networks" ? <NetworksTab refreshKey={revision} /> : null}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
