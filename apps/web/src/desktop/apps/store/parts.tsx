import type { AppJobView } from "@everyos/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { useApiResource } from "../../../features/system/use-api-resource.ts";
import { ApiRequestError } from "../../../lib/api.ts";
import { ResourceError } from "../system/parts.tsx";

export { localized } from "../localized.ts";
export function operationReason(error: unknown): string | null {
  return error instanceof ApiRequestError
    ? ((error.details as { reason?: string } | undefined)?.reason ?? null)
    : null;
}

const running = (job: AppJobView) => job.stage !== "succeeded" && job.stage !== "failed";

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
  const resource = useApiResource<AppJobView>(`/apps/jobs/${id}`, 1000, undefined, running);
  const [event, setEvent] = useState<AppJobView | null>(null);
  // Resource data and SSE state may still belong to the preceding action during a job switch.
  const currentResource = resource.data?.id === id ? resource.data : null;
  const currentEvent = event?.id === id ? event : null;
  const job =
    currentResource && !running(currentResource)
      ? currentResource
      : (currentEvent ?? currentResource);
  const finished = job && !running(job) ? job : null;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!finished || reported.current === finished.id) return;
    reported.current = finished.id;
    onChanged();
    onFinished?.(finished);
  }, [finished, onChanged, onFinished]);
  useEffect(() => {
    const stream = new EventSource(`/api/apps/jobs/${id}/events`, { withCredentials: true });
    stream.addEventListener("progress", (message) => {
      const data = JSON.parse((message as MessageEvent<string>).data) as AppJobView;
      if (data.id !== id) return;
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
