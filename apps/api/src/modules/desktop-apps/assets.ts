import { notFound } from "../../http/errors.ts";
import { DesktopAppRegistries, registryFailed, type RegistryRecord } from "./registries.ts";

const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_CACHED = 256;

/** Image types identified by their bytes, never by what the registry claims. */
function sniff(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 512).toString("utf8").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/**
 * Store icons and screenshots of apps that are not installed yet, fetched from their registry with
 * its credential and SSRF protection, identified by content and cached per index sequence.
 */
export class RegistryAssets {
  readonly #registries: DesktopAppRegistries;
  readonly #cache = new Map<string, Promise<{ content: Buffer; contentType: string }>>();

  constructor(registries: DesktopAppRegistries) {
    this.#registries = registries;
  }

  async get(
    registry: RegistryRecord,
    appId: string,
    which: { kind: "icon" } | { kind: "screenshot"; index: number },
  ): Promise<{ content: Buffer; contentType: string }> {
    const app = registry.index?.apps.find((entry) => entry.id === appId);
    const resource = which.kind === "icon" ? app?.icon : app?.screenshots[which.index];
    if (!app || !resource) throw notFound("Image");
    const url = DesktopAppRegistries.resolve(registry.url, resource);
    const key = `${registry.id}:${registry.index!.sequence}:${url}`;
    let pending = this.#cache.get(key);
    if (!pending) {
      pending = (async () => {
        const content = await this.#registries
          .fetcherFor(registry, { maxTotalBytes: MAX_ASSET_BYTES, deadlineMs: 30_000 })
          .get(url, MAX_ASSET_BYTES)
          .catch(() => {
            throw registryFailed("asset");
          });
        const contentType = sniff(content);
        if (!contentType) throw registryFailed("asset-type");
        return { content, contentType };
      })();
      pending.catch(() => this.#cache.delete(key));
      this.#cache.set(key, pending);
      if (this.#cache.size > MAX_CACHED) this.#cache.delete(this.#cache.keys().next().value!);
    }
    return pending;
  }
}
