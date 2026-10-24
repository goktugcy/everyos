import { verifyRegistryIndex } from "../packages/app-registry/src/index.ts";
import { RELEASE_TRUST } from "./official-apps-release.ts";
import { z } from "zod";

async function bounded(response: Response, max: number): Promise<string> {
  if (!response.body) throw new Error("GitHub returned no response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("GitHub release response exceeds its size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}

/** No credentials accompany the public release-asset download, including its redirects. */
export async function previousOfficialIndex(
  token: string | undefined,
  fetcher: typeof fetch = fetch,
  registryKey = RELEASE_TRUST.registry,
): Promise<string | null> {
  const metadata = await fetcher("https://api.github.com/repos/goktugcy/everyos/releases/latest", {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (metadata.status === 404) {
    await metadata.body?.cancel();
    return null;
  }
  if (!metadata.ok)
    throw new Error("Cannot inspect the previous GitHub release: HTTP " + String(metadata.status));
  const release = z
    .object({
      assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })).max(1000),
    })
    .parse(JSON.parse(await bounded(metadata, 2 * 1024 * 1024)) as unknown);
  const assets = release.assets.filter((asset) => asset.name === "official-apps.json");
  if (!assets.length) return null;
  if (assets.length !== 1) throw new Error("The previous release has duplicate official indexes");
  const url = new URL(assets[0]!.browser_download_url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/goktugcy/everyos/releases/download/") ||
    !url.pathname.endsWith("/official-apps.json")
  )
    throw new Error("Unexpected previous-index download URL");
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new Error("Cannot download the previous official index: HTTP " + String(response.status));
  const text = await bounded(response, 12 * 1024 * 1024);
  verifyRegistryIndex(text, registryKey, { official: true, allowExpired: true });
  return text;
}
