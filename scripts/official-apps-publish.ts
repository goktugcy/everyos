import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../packages/app-package/src/index.ts";
import { verifyRegistryIndex } from "../packages/app-registry/src/index.ts";
import {
  loadReleasePlan,
  PREVIOUS_INDEX_FILE,
  RELEASE_TRUST,
  verifyRelease,
  type ReleasePlan,
  type SigningTrust,
} from "./official-apps-release.ts";

const REPOSITORY = "goktugcy/everyos";
export const APP_RELEASE_TAG = /^v-apps-\d{8}-[1-9]\d{0,8}$/;
const INDEX = "official-apps.json";
const AssetSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type ReleaseAsset = z.infer<typeof AssetSchema>;
export interface PublishedRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  assets: ReleaseAsset[];
}
export interface ReleaseHost {
  get(ref: string): Promise<PublishedRelease>;
  create(tag: string, notes: string): Promise<void>;
  upload(tag: string, files: string[]): Promise<void>;
  publish(tag: string): Promise<void>;
  rename(id: number, name: string): Promise<void>;
}

/** GitHub tokens are confined to gh; application signing keys never reach a subprocess. */
export class GitHubReleaseHost implements ReleaseHost {
  async #gh(args: string[]): Promise<string> {
    const env = { ...process.env };
    delete env.EVERYOS_APP_REGISTRY_PRIVATE_KEY;
    delete env.EVERYOS_APP_PUBLISHER_PRIVATE_KEY;
    delete env.EVERYOS_RELEASE_PRIVATE_KEY;
    try {
      return (
        await promisify(execFile)("gh", args, {
          env,
          timeout: 5 * 60_000,
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout;
    } catch {
      throw new Error("GitHub release operation failed: " + args.slice(0, 2).join(" "));
    }
  }
  async get(ref: string): Promise<PublishedRelease> {
    if (ref !== "latest" && !/^v\d+\.\d+\.\d+$/.test(ref) && !APP_RELEASE_TAG.test(ref))
      throw new Error("Invalid release reference");
    const path = ref === "latest" ? "latest" : "tags/" + ref;
    const release = z
      .object({
        id: z.number().int().positive(),
        tag_name: z.string(),
        draft: z.boolean(),
        prerelease: z.boolean(),
        immutable: z.boolean(),
      })
      .parse(JSON.parse(await this.#gh(["api", `repos/${REPOSITORY}/releases/${path}`])));
    const pages = z
      .array(z.array(AssetSchema))
      .parse(
        JSON.parse(
          await this.#gh([
            "api",
            "--paginate",
            "--slurp",
            `repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100`,
          ]),
        ),
      );
    const assets = pages.flat();
    if (assets.length > 3000) throw new Error("Release has too many assets");
    return { ...release, assets };
  }
  async create(tag: string, notes: string): Promise<void> {
    await this.#gh([
      "release",
      "create",
      tag,
      "--repo",
      REPOSITORY,
      "--verify-tag",
      "--draft",
      "--prerelease",
      "--latest=false",
      "--title",
      `EveryOS apps ${tag}`,
      "--notes-file",
      notes,
    ]);
  }
  async upload(tag: string, files: string[]): Promise<void> {
    // No --clobber: published package bytes are immutable.
    await this.#gh(["release", "upload", tag, ...files, "--repo", REPOSITORY]);
  }
  async publish(tag: string): Promise<void> {
    await this.#gh([
      "release",
      "edit",
      tag,
      "--repo",
      REPOSITORY,
      "--draft=false",
      "--prerelease",
      "--latest=false",
    ]);
  }
  async rename(id: number, name: string): Promise<void> {
    await this.#gh([
      "api",
      "--method",
      "PATCH",
      `repos/${REPOSITORY}/releases/assets/${id}`,
      "-f",
      `name=${name}`,
    ]);
  }
}

function one(release: PublishedRelease, name: string): ReleaseAsset {
  const assets = release.assets.filter((asset) => asset.name === name);
  if (assets.length !== 1) throw new Error("Missing or duplicate release asset: " + name);
  return assets[0]!;
}
function match(asset: ReleaseAsset, bytes: Buffer): void {
  if (asset.size !== bytes.length || asset.digest !== "sha256:" + sha256Hex(bytes))
    throw new Error("Uploaded asset digest mismatch: " + asset.name);
}
function unchanged(
  before: PublishedRelease,
  current: PublishedRelease,
  ignored: Set<number>,
): void {
  if (
    current.id !== before.id ||
    current.tag_name !== before.tag_name ||
    current.draft ||
    current.prerelease ||
    current.immutable
  )
    throw new Error("The current EveryOS release changed or became immutable");
  for (const asset of before.assets) {
    if (ignored.has(asset.id)) continue;
    const actual = current.assets.find((item) => item.id === asset.id);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(asset))
      throw new Error("An existing release asset changed during app publication");
  }
}

/** Publish immutable app artifacts first, then advance the existing clients' discovery URL. */
export async function publishOfficialApps(
  plan: ReleasePlan,
  dir: string,
  options: {
    tag: string;
    host: ReleaseHost;
    trust?: SigningTrust;
    mode?: "development" | "release";
  },
) {
  if (!APP_RELEASE_TAG.test(options.tag)) throw new Error("Use v-apps-YYYYMMDD-N");
  const trust = options.trust ?? RELEASE_TRUST;
  const report = await verifyRelease(plan, dir, trust, options.mode ?? "release");
  const base = `https://github.com/${REPOSITORY}/releases/download/${options.tag}/`;
  if (report.assetBaseUrl !== base || !report.previousIndexSha256)
    throw new Error("Independent publication requires immutable asset URLs and a previous index");
  const previousBytes = await readFile(join(dir, PREVIOUS_INDEX_FILE));
  const previous = verifyRegistryIndex(previousBytes.toString(), trust.registry, {
    official: true,
    allowExpired: true,
  });
  const indexBytes = await readFile(join(dir, INDEX));
  const next = verifyRegistryIndex(indexBytes.toString(), trust.registry, {
    official: true,
    minSequence: previous.sequence + 1,
  });
  const host = options.host;
  const before = await host.get("latest");
  if (
    !/^v\d+\.\d+\.\d+$/.test(before.tag_name) ||
    before.draft ||
    before.prerelease ||
    before.immutable
  )
    throw new Error(
      "A mutable, published EveryOS core release is required for the compatibility catalog",
    );
  const old = one(before, INDEX);
  match(old, previousBytes);
  const backupName = `official-apps-sequence-${previous.sequence}.json`;
  const stagedName = `official-apps-next-${next.sequence}.json`;
  if (before.assets.some((a) => a.name === backupName || a.name === stagedName))
    throw new Error(
      "A prior incomplete publication needs inspection; no asset will be overwritten",
    );
  const scratch = await mkdtemp(join(tmpdir(), "everyos-app-publication-"));
  try {
    const notes = join(scratch, "notes.md");
    await writeFile(
      notes,
      `Independent EveryOS app catalog ${next.sequence}.\n\n` +
        "Updates application packages without changing the EveryOS system version.\n\n" +
        report.apps.map((app) => `- ${app.name}: ${app.version}`).join("\n") +
        "\n",
    );
    await host.create(options.tag, notes);
    const files = (await readdir(dir)).sort();
    await host.upload(
      options.tag,
      files.map((file) => join(dir, file)),
    );
    const draft = await host.get(options.tag);
    if (draft.tag_name !== options.tag || !draft.draft || draft.assets.length !== files.length)
      throw new Error("Unexpected app release draft");
    for (const file of files) match(one(draft, file), await readFile(join(dir, file)));
    await host.publish(options.tag);
    const published = await host.get(options.tag);
    if (published.draft || !published.prerelease || published.tag_name !== options.tag)
      throw new Error("App release is not publicly available outside the OS latest channel");
    for (const file of files) match(one(published, file), await readFile(join(dir, file)));
    unchanged(before, await host.get("latest"), new Set());

    // Upload before renaming anything; a failed upload leaves the current catalog untouched.
    const staged = join(scratch, stagedName);
    await writeFile(staged, indexBytes);
    await host.upload(before.tag_name, [staged]);
    const ready = await host.get("latest");
    unchanged(before, ready, new Set());
    const replacement = one(ready, stagedName);
    match(replacement, indexBytes);
    try {
      await host.rename(old.id, backupName);
      await host.rename(replacement.id, INDEX);
    } catch {
      const current = await host.get("latest");
      // A lost response may hide a successful rename. Never restore an older sequence over it.
      const active = current.assets.find((a) => a.name === INDEX);
      if (active?.id !== replacement.id) {
        if (!active && current.id === before.id) await host.rename(old.id, INDEX);
        throw new Error(
          "Catalog promotion failed; inspect the retained catalog assets before retrying",
        );
      }
    }
    const after = await host.get("latest");
    unchanged(before, after, new Set([old.id]));
    match(one(after, INDEX), indexBytes);
    match(one(after, backupName), previousBytes);
    return {
      status: "passed",
      tag: options.tag,
      coreTag: before.tag_name,
      sequence: next.sequence,
      sourceCommit: report.source.commit,
      indexSha256: sha256Hex(indexBytes),
      coreAssetsPreserved: true,
    } as const;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    if (
      process.env.CI !== "true" ||
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_REF_TYPE !== "tag" ||
      process.env.GITHUB_REPOSITORY !== REPOSITORY
    )
      throw new Error("Publication requires the protected official app tag workflow");
    const root = resolve(import.meta.dirname, "..");
    const receipt = await publishOfficialApps(
      await loadReleasePlan(root),
      join(root, "dist/official-apps"),
      {
        tag: process.env.GITHUB_REF_NAME ?? "",
        host: new GitHubReleaseHost(),
      },
    );
    await writeFile(
      join(root, "dist/official-app-publication.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    console.log("Independent official app catalog published and core assets preserved");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Official app publication failed");
    process.exitCode = 1;
  }
}
