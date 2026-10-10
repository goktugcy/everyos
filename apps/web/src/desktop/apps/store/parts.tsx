import type { AppJobView, LocalizedText } from "@otuken/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { ApiRequestError } from "../../../lib/api.ts";
import { ResourceError } from "../system/parts.tsx";

export function localized(value: LocalizedText, locale: string): string {
  return (
    value[locale] ??
    value[`${locale}_${locale === "tr" ? "TR" : "US"}`] ??
    value.en ??
    value.en_US ??
    Object.values(value)[0] ??
    ""
  );
}
export function operationReason(error: unknown): string | null {
  return error instanceof ApiRequestError
    ? ((error.details as { reason?: string } | undefined)?.reason ?? null)
    : null;
}

export function Progress({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { t } = useTranslation();
  const resource = useApiResource<AppJobView>(`/apps/jobs/${id}`, 5000);
  const [event, setEvent] = useState<AppJobView | null>(null);
  const job =
    resource.data?.stage === "succeeded" || resource.data?.stage === "failed"
      ? resource.data
      : (event ?? resource.data);
  useEffect(() => {
    const stream = new EventSource(`/api/apps/jobs/${id}/events`, { withCredentials: true });
    stream.addEventListener("progress", (message) => {
      const data = JSON.parse((message as MessageEvent<string>).data) as AppJobView;
      setEvent(data);
      onChanged();
      if (data.stage === "succeeded" || data.stage === "failed") stream.close();
    });
    stream.addEventListener("end", () => stream.close());
    return () => stream.close();
  }, [id, onChanged]);
  return job ? (
    <Alert
      tone={job.stage === "failed" ? "danger" : job.stage === "succeeded" ? "info" : "warning"}
      title={t("appStore.progress", {
        action: t(`appStore.actions.${job.action}`),
        stage: t(`appStore.stages.${job.stage}`),
      })}
    >
      <span role="status">
        {job.rollback !== "not-needed" ? t(`appStore.rollback.${job.rollback}`) : null}
      </span>
    </Alert>
  ) : (
    <ResourceError error={resource.error} />
  );
}
