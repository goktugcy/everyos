import type { ImageList, NetworkList, VolumeList, VolumeSummary } from "@otuken/shared";
import { Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { inputClassName } from "../../../components/ui/field.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { api } from "../../../lib/api.ts";
import { formatBytes, formatDateTime } from "../../../lib/format.ts";
import { usePermissions } from "../../../stores/session-store.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { LoadingBlock, ResourceError, SimulatedBadge } from "../system/parts.tsx";
import { dockerErrorMessage, shortId } from "./badges.tsx";

function Table({
  head,
  children,
  testId,
}: {
  head: ReactNode;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm" data-testid={testId}>
        <thead className="text-xs text-fg-muted">{head}</thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const th = "px-2 py-1.5 font-semibold";
const td = "border-t border-line px-2 py-1.5 align-top";

function UsedBy({ names }: { names: string[] }) {
  const { t } = useTranslation();
  return names.length === 0 ? (
    <span className="text-fg-subtle">{t("docker.images.unused")}</span>
  ) : (
    <span className="break-words text-xs">{names.join(", ")}</span>
  );
}

function useRemoval() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const remove = async (key: string, request: () => Promise<unknown>, onDone: () => void) => {
    setPending(key);
    setError(null);
    try {
      await request();
      onDone();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };
  return { pending, error, remove };
}

export function ImagesTab({ refreshKey }: { refreshKey: number }) {
  const { t, i18n } = useTranslation();
  const canManage = usePermissions().includes("docker:manage");
  const list = useApiResource<ImageList>("/docker/images", 60_000, refreshKey);
  const { pending, error, remove } = useRemoval();
  const images = list.data?.images ?? [];
  const total = images.reduce((sum, image) => sum + image.sizeBytes, 0);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span>
          {list.data
            ? t("docker.images.total", {
                count: images.length,
                size: formatBytes(total, i18n.language),
              })
            : null}
        </span>
        <SimulatedBadge source={list.data?.source} />
      </div>
      <ResourceError error={list.error} />
      {error ? <Alert tone="danger">{dockerErrorMessage(t, error)}</Alert> : null}
      {list.loading ? <LoadingBlock /> : null}
      {list.data ? (
        <Table
          testId="image-table"
          head={
            <tr>
              <th scope="col" className={th}>
                {t("docker.images.tag")}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t("docker.images.size")}
              </th>
              <th scope="col" className={th}>
                {t("docker.images.created")}
              </th>
              <th scope="col" className={th}>
                {t("docker.images.usedBy")}
              </th>
              <th scope="col" className={th} />
            </tr>
          }
        >
          {images.map((image) => {
            const name = image.tags[0] ?? shortId(image.id);
            return (
              <tr key={image.id}>
                <td className={td}>
                  <span className="break-all font-mono text-xs">
                    {image.dangling ? t("docker.images.dangling") : image.tags.join(", ")}
                  </span>
                  <span className="block font-mono text-[0.7rem] text-fg-subtle">
                    {shortId(image.id)}
                  </span>
                </td>
                <td className={`${td} text-right tabular-nums`}>
                  {formatBytes(image.sizeBytes, i18n.language)}
                </td>
                <td className={`${td} whitespace-nowrap text-xs text-fg-muted`}>
                  {formatDateTime(image.createdAt, i18n.language, { dateStyle: "medium" })}
                </td>
                <td className={td}>
                  <UsedBy names={image.usedBy} />
                </td>
                <td className={`${td} text-right`}>
                  {canManage && image.usedBy.length === 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${t("docker.images.remove")} ${name}`}
                      loading={pending === image.id}
                      disabled={pending !== null}
                      onClick={() =>
                        void requestConfirm({
                          title: t("docker.images.removeTitle"),
                          body: t("docker.images.removeBody", { name }),
                          confirmLabel: t("docker.images.remove"),
                        }).then((ok) => {
                          if (ok)
                            void remove(
                              image.id,
                              () =>
                                api(`/docker/images/${encodeURIComponent(image.id)}`, {
                                  method: "DELETE",
                                }),
                              list.reload,
                            );
                        })
                      }
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </Table>
      ) : null}
      {list.data && images.length === 0 ? (
        <p className="p-6 text-center text-sm text-fg-muted">{t("docker.images.empty")}</p>
      ) : null}
    </div>
  );
}

function DeleteVolumeDialog({
  volume,
  onClose,
  onDeleted,
}: {
  volume: VolumeSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await api(`/docker/volumes/${encodeURIComponent(volume.name)}`, {
        method: "DELETE",
        body: { confirmName: typed },
      });
      onDeleted();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("docker.volumes.removeTitle", { name: volume.name })}
    >
      <form
        className="flex flex-col gap-4 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed === volume.name) void submit();
        }}
      >
        <Alert tone="danger">{t("docker.volumes.removeBody")}</Alert>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8rem] font-medium text-fg-muted">
            {t("docker.volumes.typeToConfirm")}
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className={inputClassName}
            autoComplete="off"
            spellCheck={false}
            placeholder={volume.name}
          />
        </label>
        {error ? <Alert tone="danger">{dockerErrorMessage(t, error)}</Alert> : null}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" loading={pending} disabled={typed !== volume.name}>
            {t("docker.volumes.deleteForever")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function VolumesTab({ refreshKey }: { refreshKey: number }) {
  const { t, i18n } = useTranslation();
  const canDelete = usePermissions().includes("docker:delete");
  const list = useApiResource<VolumeList>("/docker/volumes", 60_000, refreshKey);
  const [deleting, setDeleting] = useState<VolumeSummary | null>(null);
  const volumes = list.data?.volumes ?? [];

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2 text-xs text-fg-subtle">
        <span>{!canDelete ? t("docker.volumes.noPermission") : null}</span>
        <SimulatedBadge source={list.data?.source} />
      </div>
      <ResourceError error={list.error} />
      {list.loading ? <LoadingBlock /> : null}
      {list.data ? (
        <Table
          testId="volume-table"
          head={
            <tr>
              <th scope="col" className={th}>
                {t("docker.volumes.name")}
              </th>
              <th scope="col" className={`${th} text-right`}>
                {t("docker.volumes.size")}
              </th>
              <th scope="col" className={th}>
                {t("docker.volumes.project")}
              </th>
              <th scope="col" className={th}>
                {t("docker.volumes.usedBy")}
              </th>
              <th scope="col" className={th} />
            </tr>
          }
        >
          {volumes.map((volume) => (
            <tr key={volume.name}>
              <td className={td}>
                <span className="break-all font-mono text-xs">{volume.name}</span>
                <span className="block text-[0.7rem] text-fg-subtle">{volume.driver}</span>
              </td>
              <td className={`${td} text-right tabular-nums`}>
                {volume.sizeBytes !== null ? formatBytes(volume.sizeBytes, i18n.language) : "—"}
              </td>
              <td className={`${td} text-xs`}>{volume.project ?? "—"}</td>
              <td className={td}>
                <UsedBy names={volume.usedBy} />
              </td>
              <td className={`${td} text-right`}>
                {canDelete && volume.usedBy.length === 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t("docker.volumes.remove")} ${volume.name}`}
                    onClick={() => setDeleting(volume)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
      {list.data && volumes.length === 0 ? (
        <p className="p-6 text-center text-sm text-fg-muted">{t("docker.volumes.empty")}</p>
      ) : null}
      {deleting ? (
        <DeleteVolumeDialog
          volume={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            list.reload();
          }}
        />
      ) : null}
    </div>
  );
}

export function NetworksTab({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const canManage = usePermissions().includes("docker:manage");
  const list = useApiResource<NetworkList>("/docker/networks", 60_000, refreshKey);
  const { pending, error, remove } = useRemoval();
  const networks = list.data?.networks ?? [];

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-end">
        <SimulatedBadge source={list.data?.source} />
      </div>
      <ResourceError error={list.error} />
      {error ? <Alert tone="danger">{dockerErrorMessage(t, error)}</Alert> : null}
      {list.loading ? <LoadingBlock /> : null}
      {list.data ? (
        <Table
          testId="network-table"
          head={
            <tr>
              <th scope="col" className={th}>
                {t("docker.networks.name")}
              </th>
              <th scope="col" className={th}>
                {t("docker.networks.driver")}
              </th>
              <th scope="col" className={th}>
                {t("docker.networks.subnets")}
              </th>
              <th scope="col" className={th}>
                {t("docker.networks.usedBy")}
              </th>
              <th scope="col" className={th} />
            </tr>
          }
        >
          {networks.map((network) => (
            <tr key={network.id}>
              <td className={td}>
                <span className="break-all font-mono text-xs">{network.name}</span>
                {network.builtIn ? (
                  <span className="block text-[0.7rem] text-fg-subtle">
                    {t("docker.networks.builtIn")}
                  </span>
                ) : null}
              </td>
              <td className={`${td} text-xs`}>{network.driver}</td>
              <td className={`${td} font-mono text-xs`}>{network.subnets.join(", ") || "—"}</td>
              <td className={td}>
                <UsedBy names={network.usedBy} />
              </td>
              <td className={`${td} text-right`}>
                {canManage && !network.builtIn && network.usedBy.length === 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t("docker.networks.remove")} ${network.name}`}
                    loading={pending === network.id}
                    disabled={pending !== null}
                    onClick={() =>
                      void requestConfirm({
                        title: t("docker.networks.removeTitle", { name: network.name }),
                        body: t("docker.networks.removeBody"),
                        confirmLabel: t("docker.networks.remove"),
                      }).then((ok) => {
                        if (ok)
                          void remove(
                            network.id,
                            () => api(`/docker/networks/${network.id}`, { method: "DELETE" }),
                            list.reload,
                          );
                      })
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
      {list.data && networks.length === 0 ? (
        <p className="p-6 text-center text-sm text-fg-muted">{t("docker.networks.empty")}</p>
      ) : null}
    </div>
  );
}
