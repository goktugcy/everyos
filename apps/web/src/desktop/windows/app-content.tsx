import {
  Component,
  lazy,
  memo,
  Suspense,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { APP_MANIFESTS } from "../apps/registry.ts";

/** One lazy component per app, created once; each app's code loads on first use only. */
const LAZY_APPS: Readonly<Record<string, LazyExoticComponent<ComponentType>>> = Object.fromEntries(
  APP_MANIFESTS.map((manifest) => [manifest.id, lazy(manifest.load)]),
);

function Crashed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <AlertTriangle className="size-8 text-warning" aria-hidden />
      <p className="max-w-sm text-sm text-fg-muted">{t("window.crashed")}</p>
      <Button variant="secondary" onClick={onRetry}>
        {t("window.reload")}
      </Button>
    </div>
  );
}

/** Isolates app crashes: a failing app never takes down the desktop or other windows. */
class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; attempt: number }
> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <Crashed
          onRetry={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}
        />
      );
    }
    return (
      <div key={this.state.attempt} className="contents">
        {this.props.children}
      </div>
    );
  }
}

export function AppLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6 text-fg-subtle" label={t("window.loading")} />
    </div>
  );
}

/** Renders an app's lazily loaded component inside an error boundary. */
export const AppContent = memo(function AppContent({ appId }: { appId: string }) {
  const App = LAZY_APPS[appId];
  if (!App) return null;
  return (
    <AppErrorBoundary>
      <Suspense fallback={<AppLoading />}>
        <App />
      </Suspense>
    </AppErrorBoundary>
  );
});
