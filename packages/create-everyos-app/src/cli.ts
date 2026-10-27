#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CreateError, createProject, TEMPLATES, type Template } from "./create.ts";

/** Command output (a CLI prints; the rest of EveryOS logs). */
const say = (text: unknown) => process.stdout.write(`${String(text)}\n`);
const complain = (text: unknown) =>
  process.stderr.write(`${text instanceof Error ? (text.stack ?? text.message) : String(text)}\n`);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    template: { type: "string", short: "t" },
    id: { type: "string" },
    name: { type: "string" },
    "publisher-id": { type: "string" },
    "publisher-name": { type: "string" },
    packages: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const dir = positionals[0];
if (values.help || !dir) {
  say(`create-everyos-app <folder> [--template ${TEMPLATES.join("|")}]
  [--id com.example.notes] [--name "Notes"] [--publisher-id com.example] [--publisher-name "Example"]
  [--packages <url or folder with the SDK .tgz files | npm>]`);
  process.exit(dir ? 0 : 1);
}
try {
  const created = await createProject({
    dir,
    template: (values.template ?? "vanilla") as Template,
    ...(values.id ? { id: values.id } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values["publisher-id"] ? { publisherId: values["publisher-id"] } : {}),
    ...(values["publisher-name"] ? { publisherName: values["publisher-name"] } : {}),
    ...(values.packages ? { packages: values.packages } : {}),
  });
  say(`Created ${created.id} in ${created.dir}

  cd ${dir}
  npm install
  npm run dev`);
} catch (error) {
  complain(error instanceof CreateError ? `✖ ${error.message}` : error);
  process.exit(1);
}
