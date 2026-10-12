import type { IntegrationAdapter, IntegrationView } from "@everyos/shared";
import { useApiResource } from "../../features/system/use-api-resource.ts";
import { usePermissions } from "../../stores/session-store.ts";

/** Form needs of each built-in adapter (the server validates the same rules). */
export const ADAPTER_FORMS: Record<
  IntegrationAdapter,
  { baseUrl: boolean; secret: boolean; username: boolean; defaultPort: number | null }
> = {
  jellyfin: { baseUrl: true, secret: true, username: false, defaultPort: 8096 },
  immich: { baseUrl: true, secret: true, username: false, defaultPort: 2283 },
  homeassistant: { baseUrl: true, secret: true, username: false, defaultPort: 8123 },
  uptimekuma: { baseUrl: true, secret: true, username: false, defaultPort: 3001 },
  nextcloud: { baseUrl: true, secret: true, username: true, defaultPort: null },
  postgresql: { baseUrl: false, secret: false, username: false, defaultPort: null },
};

/** Integrations the signed-in user may see (refetched whenever the caller mounts). */
export function useIntegrations(): {
  integrations: IntegrationView[];
  loading: boolean;
  error: unknown;
  reload: () => void;
} {
  const canRead = usePermissions().includes("apps:read");
  const resource = useApiResource<{ integrations: IntegrationView[] }>(
    canRead ? "/integrations" : null,
    null,
  );
  return {
    integrations: resource.data?.integrations ?? [],
    loading: canRead && resource.loading,
    error: resource.error,
    reload: resource.reload,
  };
}
