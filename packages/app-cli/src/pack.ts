import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppManifest } from "@everyos/app-manifest";
import { packDirectory, sha256Hex } from "@everyos/app-package";
import { build } from "./build.ts";
import { CliError, type Project } from "./project.ts";
import { formatFindings, validateBuild, type Finding } from "./validate.ts";

export interface Packed {
  file: string;
  bytes: Buffer;
  sha256: string;
  manifest: AppManifest;
  findings: Finding[];
}

/** Builds, validates (errors refuse) and packs the project into `<id>-<version>.eosapp`. */
export async function pack(project: Project, options: { out?: string } = {}): Promise<Packed> {
  const outDir = await build(project);
  const { manifest, findings } = await validateBuild(outDir);
  if (!manifest || findings.some((finding) => finding.level === "error"))
    throw new CliError(`The package is not valid:\n${formatFindings(findings)}`);
  const { bytes } = await packDirectory(outDir);
  const file = options.out ?? join(project.root, `${manifest.id}-${manifest.version}.eosapp`);
  await writeFile(file, bytes);
  return { file, bytes, sha256: sha256Hex(bytes), manifest, findings };
}
