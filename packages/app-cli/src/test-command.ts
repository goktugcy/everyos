import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "./build.ts";
import { CliError, type Project } from "./project.ts";
import { formatFindings, validateBuild } from "./validate.ts";

/** Command output (a CLI prints; the rest of EveryOS logs). */
const say = (text: unknown) => process.stdout.write(`${String(text)}\n`);

/**
 * `everyos-app test`: builds and validates the package (errors fail), then runs the project's own
 * tests with its Vitest (the templates test against @everyos/app-testing's MOCK host).
 */
export async function test(project: Project, args: string[] = []): Promise<number> {
  const outDir = await build(project);
  const { findings } = await validateBuild(outDir);
  if (findings.length) say(formatFindings(findings));
  if (findings.some((finding) => finding.level === "error")) return 1;
  const vitest = join(project.root, "node_modules", ".bin", "vitest");
  if (!existsSync(vitest))
    throw new CliError("Vitest is not installed in this project (npm install --save-dev vitest)");
  return new Promise((resolve) => {
    const child = spawn(vitest, ["run", ...args], { cwd: project.root, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
