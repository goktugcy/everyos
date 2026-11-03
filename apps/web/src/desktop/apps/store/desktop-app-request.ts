import type { DesktopAppInstallationView, DesktopAppListing } from "@everyos/shared";

export interface DesktopAppRequest {
  appId: string;
  registryId: string;
  requestId: string;
}

export function readDesktopAppRequest(value: unknown): DesktopAppRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<DesktopAppRequest>;
  if (
    typeof request.appId !== "string" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/.test(request.appId) ||
    request.appId.length > 128 ||
    typeof request.registryId !== "string" ||
    !/^[\w-]{1,64}$/.test(request.registryId) ||
    typeof request.requestId !== "string" ||
    !/^[\w-]{1,128}$/.test(request.requestId)
  )
    return null;
  return { appId: request.appId, registryId: request.registryId, requestId: request.requestId };
}

/** An installation from a different registry must never masquerade as the requested app. */
export function requestedDesktopApp(
  request: DesktopAppRequest,
  listings: readonly DesktopAppListing[],
  installations: readonly DesktopAppInstallationView[],
) {
  const listing =
    listings.find(
      (entry) => entry.appId === request.appId && entry.registry.id === request.registryId,
    ) ?? null;
  const installation =
    installations.find(
      (entry) => entry.appId === request.appId && entry.registry?.id === request.registryId,
    ) ?? null;
  return listing || installation ? { listing, installation } : null;
}
