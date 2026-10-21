import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { capabilityInfo, type AppManifest } from "@everyos/app-manifest";
import { ManifestError, parseManifest } from "@everyos/app-manifest/schema";
import { contentTypeOf, PACKAGE_LIMITS, requiredFiles } from "@everyos/app-package";

/*
 * What `everyos-app validate` checks in a built package directory: the manifest exactly as EveryOS
 * checks it, the files it refers to, file types EveryOS serves, HTML that the app sandbox's
 * content security policy would block, complete translations, and the package limits.
 */

export interface Finding {
  level: "error" | "warning";
  file: string;
  message: string;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(relative(dir, path).split("\\").join("/"));
    }
  };
  await walk(dir);
  return out.sort();
}

const keysOf = (value: unknown, prefix = ""): string[] =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, inner]) =>
        typeof inner === "object" && inner !== null && !Array.isArray(inner)
          ? keysOf(inner, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      )
    : [];

/** HTML the app's CSP refuses at run time (inline or remote code, inline handlers, `<base>`). */
export function htmlProblems(html: string): string[] {
  const problems: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? "";
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1];
    if (!src && (match[2] ?? "").trim())
      problems.push("inline <script> (blocked: move the code into a bundled file)");
    if (src && /^(?:[a-z]+:)?\/\//i.test(src))
      problems.push(`remote script ${src} (blocked: bundle it with the app)`);
  }
  for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/gi))
    if (/^(?:[a-z]+:)?\/\//i.test(match[1] ?? ""))
      problems.push(`remote resource ${match[1]} (blocked: apps load their own files only)`);
  if (/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, "")))
    problems.push("inline event handler attribute (blocked: add listeners in code)");
  if (/<base\b/i.test(html)) problems.push("<base> element (blocked)");
  return problems;
}

/** Validates a built package directory; errors make `pack` and `publish` refuse. */
export async function validateBuild(dir: string): Promise<{
  manifest: AppManifest | null;
  findings: Finding[];
}> {
  const findings: Finding[] = [];
  const error = (file: string, message: string) => findings.push({ level: "error", file, message });
  const warning = (file: string, message: string) =>
    findings.push({ level: "warning", file, message });
  const files = await listFiles(dir);
  let manifest: AppManifest | null = null;
  try {
    manifest = parseManifest(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")));
  } catch (caught) {
    if (caught instanceof ManifestError)
      for (const issue of caught.issues)
        error("manifest.json", `${issue.path || "(root)"}: ${issue.message}`);
    else error("manifest.json", (caught as Error).message);
  }

  let total = 0;
  for (const file of files) {
    total += (await stat(join(dir, file))).size;
    if (!contentTypeOf(file)) error(file, "EveryOS does not serve this type of file");
    if (file.endsWith(".html"))
      for (const problem of htmlProblems(await readFile(join(dir, file), "utf8")))
        error(file, problem);
  }
  if (total > PACKAGE_LIMITS.unpackedBytes)
    error("(package)", `${total} bytes: more than the ${PACKAGE_LIMITS.unpackedBytes} allowed`);
  if (files.length > PACKAGE_LIMITS.entries)
    error("(package)", `${files.length} files: more than the ${PACKAGE_LIMITS.entries} allowed`);
  if (!manifest) return { manifest, findings };

  const present = new Set(files);
  for (const file of requiredFiles(manifest))
    if (!present.has(file)) error(file, "the manifest refers to it, but it is not in the package");

  if (manifest.locales) {
    const { path, supported, default: fallback } = manifest.locales;
    const read = async (locale: string) => {
      try {
        return JSON.parse(await readFile(join(dir, path, `${locale}.json`), "utf8")) as unknown;
      } catch {
        return null;
      }
    };
    const base = await read(fallback);
    const expected = new Set(keysOf(base));
    if (!expected.has("app.name"))
      warning(`${path}/${fallback}.json`, "no app.name: EveryOS shows the manifest's name");
    for (const widget of manifest.widgets)
      if (!expected.has(`widgets.${widget.id}.name`))
        warning(`${path}/${fallback}.json`, `no widgets.${widget.id}.name`);
    for (const locale of supported) {
      if (locale === fallback) continue;
      const messages = await read(locale);
      if (messages === null) continue;
      const keys = new Set(keysOf(messages));
      const missing = [...expected].filter((key) => !keys.has(key));
      if (missing.length)
        error(
          `${path}/${locale}.json`,
          `missing ${missing.length} text(s): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`,
        );
    }
  }
  for (const capability of manifest.permissions) {
    const info = capabilityInfo(capability);
    if (info.risk === "elevated")
      warning("manifest.json", `${capability} is elevated: only an administrator can approve it`);
    else if (info.risk === "sensitive")
      warning("manifest.json", `${capability} is sensitive: people approve it when installing`);
  }
  return { manifest, findings };
}

export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map(
      (finding) => `${finding.level === "error" ? "✖" : "⚠"} ${finding.file}: ${finding.message}`,
    )
    .join("\n");
}
