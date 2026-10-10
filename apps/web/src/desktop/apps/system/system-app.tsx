import { Tabs } from "radix-ui";
import { useTranslation } from "react-i18next";
import { SystemInfoView } from "../../../features/system/system-card.tsx";
import { useSystemInfo } from "../../../features/system/use-system-info.ts";
import { useLiveMetricsSubscription } from "../../../features/metrics/live-metrics.ts";
import { useAppStateField } from "../app-context.ts";
import { HardwareTab } from "./hardware-tab.tsx";
import { NetworkTab } from "./network-tab.tsx";
import { OverviewTab } from "./overview-tab.tsx";
import { ProcessesTab } from "./processes-tab.tsx";
import { StorageTab } from "./storage-tab.tsx";

const TABS = ["overview", "storage", "network", "processes", "hardware", "info"] as const;

function InfoTab() {
  const state = useSystemInfo();
  return <SystemInfoView state={state} />;
}

/** System Monitor: live metrics, storage, network, processes and hardware health. */
export default function SystemApp() {
  const { t } = useTranslation();
  const [tab, setTab] = useAppStateField("tab", TABS, "overview");
  useLiveMetricsSubscription();

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => setTab(value as (typeof TABS)[number])}
      className="flex h-full min-h-0 flex-col"
    >
      <Tabs.List
        aria-label={t("apps.system")}
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 pt-2"
      >
        {TABS.map((id) => (
          <Tabs.Trigger
            key={id}
            value={id}
            className="-mb-px whitespace-nowrap rounded-t-otk-sm border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-fg"
          >
            {t(`monitor.tabs.${id}`)}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {TABS.map((id) => (
        <Tabs.Content
          key={id}
          value={id}
          className="@container min-h-0 flex-1 overflow-y-auto p-4 outline-none"
        >
          {id === "overview" ? <OverviewTab /> : null}
          {id === "storage" ? <StorageTab /> : null}
          {id === "network" ? <NetworkTab /> : null}
          {id === "processes" ? <ProcessesTab /> : null}
          {id === "hardware" ? <HardwareTab /> : null}
          {id === "info" ? <InfoTab /> : null}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
