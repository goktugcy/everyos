import type { AppJobView, LocalizedText } from "@everyos/shared";
import { useEffect, useRef, useState } from "react";
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

export function Progress({
  id,
  onChanged,
  onFinished,
  dismissed = false,
  onDismiss,
}: {
  id: string;
  onChanged: () => void;
  /** Called once when the job succeeds or fails. */
  onFinished?: (job: AppJobView) => void;
  dismissed?: boolean;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const resource = useApiResource<AppJobView>(`/apps/jobs/${id}`, 5000);
  const [event, setEvent] = useState<AppJobView | null>(null);
  const job =
    resource.data?.stage === "succeeded" || resource.data?.stage === "failed"
      ? resource.data
      : (event ?? resource.data);
  const finished = job?.stage === "succeeded" || job?.stage === "failed" ? job : null;
  const reported = useRef(false);
  useEffect(() => {
    if (!finished || reported.current) return;
    reported.current = true;
    onChanged();
    onFinished?.(finished);
  }, [finished, onChanged, onFinished]);
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
  if (dismissed) return null;
  return job ? (
    <div data-testid="app-job-progress">
      <Alert
        onDismiss={onDismiss}
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
    </div>
  ) : (
    <ResourceError error={resource.error} onDismiss={onDismiss} />
  );
}
