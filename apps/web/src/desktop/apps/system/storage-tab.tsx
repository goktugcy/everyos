import type { StorageUsage } from "@otuken/shared";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLiveMetrics } from "../../../features/metrics/live-metrics.ts";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { formatBytes, formatNumber } from "../../../lib/format.ts";
import { LoadingBlock, Meter, ResourceError, SectionTitle, SimulatedBadge } from "./parts.tsx";

export function StorageTab() {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const storage = useApiResource<StorageUsage>("/system/storage", 30_000);
  const disks = useLiveMetrics((state) => state.snapshot?.disks ?? null);

  return (
    <div className="flex flex-col gap-5">
      <ResourceError error={storage.error} />
      {storage.loading ? <LoadingBlock /> : null}
      {storage.data ? (
        <section className="flex flex-col gap-2">
          <SectionTitle aside={<SimulatedBadge source={storage.data.source} />}>
            {t("monitor.tabs.storage")}
          </SectionTitle>
          {storage.data.mounts.length === 0 ? (
            <p className="text-sm text-fg-muted">{t("monitor.storage.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {storage.data.mounts.map((mount) => {
                const percent =
                  mount.totalBytes > 0
                    ? (mount.usedBytes / (mount.usedBytes + mount.availableBytes || 1)) * 100
                    : 0;
                const inodes =
                  mount.inodesTotal > 0
                    ? ((mount.inodesTotal - mount.inodesFree) / mount.inodesTotal) * 100
                    : null;
                return (
                  <li
                    key={`${mount.device}-${mount.mountpoint}`}
                    className="glass-inset flex flex-col gap-2 rounded-otk-md p-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="flex items-center gap-1.5 font-mono text-sm font-semibold text-fg">
                        {mount.mountpoint}
                        {mount.readOnly ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-hover/8 px-2 py-0.5 font-sans text-[0.7rem] font-medium text-fg-muted">
                            <Lock className="size-3" aria-hidden />
                            {t("monitor.storage.readOnly")}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-fg-muted">
                        {mount.device} · {mount.fsType}
                      </span>
                    </div>
                    <Meter
                      percent={percent}
                      label={`${mount.mountpoint} ${t("monitor.storage.usage")}`}
                    />
                    <div className="flex flex-wrap justify-between gap-x-3 text-xs text-fg-muted">
                      <span>
                        {t("monitor.usedOf", {
                          used: formatBytes(mount.usedBytes, language),
                          total: formatBytes(mount.totalBytes, language),
                        })}{" "}
                        ·{" "}
                        {t("monitor.storage.free", {
                          free: formatBytes(mount.availableBytes, language),
                        })}
                      </span>
                      {inodes !== null ? (
                        <span>
                          {t("monitor.storage.inodes", { percent: formatNumber(inodes, language) })}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {disks && disks.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>{t("monitor.storage.diskIo")}</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead className="text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="py-1.5 pr-3 font-semibold">
                    {t("monitor.storage.device")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-semibold">
                    {t("monitor.read")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-semibold">
                    {t("monitor.write")}
                  </th>
                  <th scope="col" className="py-1.5 text-right font-semibold">
                    {t("monitor.storage.usage")}
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {disks.map((disk) => (
                  <tr key={disk.name} className="border-t border-line">
                    <td className="py-1.5 pr-3 font-mono text-xs">{disk.name}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {t("monitor.perSecond", {
                        value: formatBytes(disk.readBytesPerSec, language),
                      })}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {t("monitor.perSecond", {
                        value: formatBytes(disk.writeBytesPerSec, language),
                      })}
                    </td>
                    <td className="py-1.5 text-right">
                      {t("monitor.storage.busy", {
                        percent: formatNumber(disk.busyPercent, language),
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
