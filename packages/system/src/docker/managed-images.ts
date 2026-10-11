import { parse, stringify } from "yaml";
import type { AppImage } from "@everyos/shared";
import { findExecutable, runCapture, SAFE_ENV } from "../exec.ts";
import { homedir } from "node:os";

export async function resolveManagedImages(
  socketPath: string,
  input: string,
  platform: string,
  update: boolean,
  signal?: AbortSignal,
): Promise<{ compose: string; images: AppImage[] }> {
  const docker = await findExecutable("docker");
  if (!docker) throw new Error("Docker CLI unavailable");
  const doc = parse(input, { maxAliasCount: 50 }) as {
    services: Record<string, Record<string, unknown>>;
  };
  const images: AppImage[] = [];
  const resolved = new Map<string, string>();
  const env = { ...SAFE_ENV, HOME: homedir(), DOCKER_HOST: `unix://${socketPath}` };
  for (const service of Object.values(doc.services)) {
    const reference = String(service.image);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,2047}$/.test(reference))
      throw new Error("Invalid image reference");
    const key = `${reference}:${String(service.pull_policy)}`;
    let pinned = resolved.get(key);
    if (!pinned) {
      const inspect = async () => {
        const result = await runCapture(
          docker,
          ["image", "inspect", "--format", "{{json .}}", reference],
          { env, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, ...(signal ? { signal } : {}) },
        );
        return result.exitCode === 0
          ? (JSON.parse(result.output) as Record<string, unknown>)
          : null;
      };
      let image = await inspect();
      if (
        (!image || update || service.pull_policy === "always") &&
        service.pull_policy !== "never"
      ) {
        const result = await runCapture(
          docker,
          ["image", "pull", "--platform", platform, reference],
          { env, timeoutMs: 5 * 60_000, maxOutputBytes: 0, ...(signal ? { signal } : {}) },
        );
        if (result.exitCode !== 0) throw new Error("Image pull failed");
        image = await inspect();
      }
      if (
        !image ||
        `${String(image.Os)}/${String(image.Architecture)}` !==
          platform.split("/").slice(0, 2).join("/")
      )
        throw new Error("Image platform mismatch");
      const digests = Array.isArray(image.RepoDigests)
        ? image.RepoDigests.filter(
            (value): value is string =>
              typeof value === "string" &&
              /^[A-Za-z0-9][A-Za-z0-9._/:@-]+@sha256:[a-f0-9]{64}$/.test(value),
          )
        : [];
      const requested = reference.match(/@sha256:([a-f0-9]{64})$/)?.[1];
      pinned =
        (requested ? digests.find((digest) => digest.endsWith(requested)) : digests[0]) ??
        (typeof image.Id === "string" && /^sha256:[a-f0-9]{64}$/.test(image.Id)
          ? image.Id
          : undefined);
      if (!pinned || (requested && !pinned.endsWith(requested)))
        throw new Error("Image digest mismatch");
      const digest = pinned.match(/sha256:[a-f0-9]{64}$/)?.[0] ?? null;
      images.push({ reference: pinned, digest, platform });
      resolved.set(key, pinned);
    }
    service.image = pinned;
    // A resolved configuration always restores the same artifact during rollback.
    service.pull_policy = "never";
  }
  return { compose: stringify(doc, { lineWidth: 0 }), images };
}
