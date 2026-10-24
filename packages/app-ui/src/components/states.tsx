import { AlertTriangle, Inbox, LoaderCircle } from "lucide-react";
import { Component, type ReactNode } from "react";
import { useT } from "../app.tsx";
import { errorMessage } from "../files.ts";
import { Button } from "./controls.tsx";

export function EmptyState({
  icon,
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title?: string;
  text?: string;
  action?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="eui-state" data-testid="empty-state">
      <span className="eui-state-icon">{icon ?? <Inbox size={32} aria-hidden />}</span>
      <p className="eui-state-title">{title ?? t("ui.empty")}</p>
      {text ? <p className="eui-state-text">{text}</p> : null}
      {action}
    </div>
  );
}

export function LoadingState({ text }: { text?: string }) {
  const t = useT();
  return (
    <div className="eui-state" role="status" aria-live="polite" data-testid="loading-state">
      <LoaderCircle size={24} className="eui-spinner" aria-hidden />
      <span>{text ?? t("ui.loading")}</span>
    </div>
  );
}

export function ErrorState({
  error,
  title,
  onRetry,
}: {
  error?: unknown;
  title?: string;
  onRetry?: () => void;
}) {
  const t = useT();
  const message = error === undefined ? t("ui.errorText") : errorMessage(t, error);
  return (
    <div className="eui-state" data-tone="error" role="alert" data-testid="error-state">
      <span className="eui-state-icon">
        <AlertTriangle size={30} aria-hidden />
      </span>
      <p className="eui-state-title">{title ?? t("ui.errorTitle")}</p>
      {message ? <p className="eui-state-text">{message}</p> : null}
      {onRetry ? <Button onClick={onRetry}>{t("ui.retry")}</Button> : null}
    </div>
  );
}

/** Keeps a failing part of an app from blanking the whole window. */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: (reset: () => void) => ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    const reset = () => this.setState({ failed: false });
    if (!this.state.failed) return this.props.children;
    return this.props.fallback ? this.props.fallback(reset) : <ErrorState onRetry={reset} />;
  }
}
