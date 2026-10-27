/*
 * The built-in desktop app registries' trust anchors. The official index and its packages are
 * published as EveryOS release assets, signed in the protected release environment with the app
 * registry key; the community registry is the service in `services/community-registry`. Until an
 * anchor is pinned here the registry is absent from the build: pinning both is a release gate
 * (docs/sdk-release-acceptance.md). Root-owned configuration (`desktopApps`) can override them.
 */

export interface RegistryAnchor {
  url: string;
  publicKey: string;
  /** Set only by root-owned configuration, for a mirror on the local network. */
  allowPrivate?: boolean | undefined;
}

export const OFFICIAL_APP_REGISTRY: RegistryAnchor = {
  url: "https://github.com/goktugcy/everyos/releases/latest/download/official-apps.json",
  publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjauU9Ml5GADdAg33tB83gcZ1/+9+1zfQ+Vd8SHT3mXA=
-----END PUBLIC KEY-----`,
};

export const COMMUNITY_APP_REGISTRY: RegistryAnchor = {
  url: "https://registry.everyos.net/index.json",
  publicKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+pJMxzRwIh2LCEjOanK4oH/mSxAz1OW1dcH7kohOIk0=
-----END PUBLIC KEY-----`,
};
