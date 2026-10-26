#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CommunityDeploymentError, inspectCommunityDeployment } from "./community-deployment.ts";

try {
  const { values } = parseArgs({
    options: {
      "public-key": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm community:inspect --public-key <independently-retained-public.pem> [--out new-report.json]",
    );
    console.log(
      "Read-only HTTPS identity/catalog checks. No tokens, private keys or lifecycle acceptance.",
    );
  } else {
    if (!values["public-key"]) throw new CommunityDeploymentError("public-key-argument");
    const publicKey = await readFile(values["public-key"], "utf8");
    const report = await inspectCommunityDeployment(publicKey);
    const text = JSON.stringify(report, null, 2) + "\n";
    if (values.out) await writeFile(values.out, text, { flag: "wx", mode: 0o600 });
    console.log(text.trimEnd());
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      check: error instanceof CommunityDeploymentError ? error.check : "input-or-report-file",
    }),
  );
  process.exitCode = 1;
}
