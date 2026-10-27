#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { parseArgs } from "node:util";
import JSON5 from "json5";

/** Creates a reviewable configuration; it never calls Cloudflare or provisions resources. */
const { values } = parseArgs({
  options: {
    "database-id": { type: "string" },
    bucket: { type: "string" },
  },
});
const databaseId = values["database-id"],
  bucket = values.bucket;
if (
  !databaseId ||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(databaseId) ||
  databaseId === "00000000-0000-0000-0000-000000000000" ||
  !bucket ||
  !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
)
  throw new Error("Pass the owner's real --database-id <UUID> and --bucket <R2 bucket name>");
const base = JSON5.parse<Record<string, unknown>>(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const production = {
  ...base,
  routes: [{ pattern: "everyos.goktugceyhan.dev", custom_domain: true }],
  d1_databases: [
    {
      binding: "DB",
      database_name: "everyos-community",
      database_id: databaseId,
      migrations_dir: "migrations",
    },
  ],
  r2_buckets: [{ binding: "ARTIFACTS", bucket_name: bucket }],
  vars: { PUBLIC_ORIGIN: "https://everyos.goktugceyhan.dev", ENVIRONMENT: "production" },
};
await writeFile(
  new URL("../wrangler.production.jsonc", import.meta.url),
  JSON.stringify(production, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
process.stdout.write("Created wrangler.production.jsonc; review it before owner deployment.\n");
