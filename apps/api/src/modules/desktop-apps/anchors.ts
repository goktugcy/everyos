/*
 * The built-in desktop app registries' trust anchors. The official index and its packages are
 * published as EveryOS release assets, signed in the protected release environment with the app
 * registry key; the community registry is the service in `services/community-registry`. Until a
 * key is pinned here the registry is simply absent from the build: pinning both is a release gate
 * (docs/sdk-release-acceptance.md). Root-owned configuration (`desktopApps`) can override them.
 */

export interface RegistryAnchor {
  url: string;
  publicKey: string;
}

export const OFFICIAL_APP_REGISTRY: RegistryAnchor | null = null;

export const COMMUNITY_APP_REGISTRY: RegistryAnchor | null = null;
