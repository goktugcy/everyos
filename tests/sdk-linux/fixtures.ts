/** Ephemeral signatures and local fixtures, never production registry credentials. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  build,
  initRegistry,
  loadProject,
  publishPackage,
  revokeVersion,
} from "../../packages/app-cli/src/index.ts";
import { packDirectory } from "../../packages/app-package/src/index.ts";

const root = resolve(import.meta.dirname, "../..");
const out = join(root, "dist/sdk-linux-fixture");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const paths = {
  dir: join(out, "registry"),
  key: join(out, "registry.key"),
  publisherKey: join(out, "publisher.key"),
};
const identity = await initRegistry(paths, {
  id: "qualification",
  name: "Disposable Linux qualification",
  publisherId: "com.example",
  publisherName: "Acceptance fixture",
});
const project = await loadProject(join(root, "official-apps/notes"));
project.config.outDir = relative(project.root, join(out, "app-build"));
project.manifest.id = "com.example.qualification";
project.manifest.publisher = { id: "com.example", name: "Acceptance fixture" };
for (const version of ["1.0.0", "1.0.1"]) {
  project.manifest.version = version;
  const built = await build(project);
  await writeFile(join(built, "manifest.json"), JSON.stringify(project.manifest));
  const packed = await packDirectory(built);
  const file = join(out, `qualification-${version}.eosapp`);
  await writeFile(file, packed.bytes);
  await publishPackage(paths, file, { iconFile: join(built, "icon.svg") });
  await writeFile(
    join(out, `index-${version}.json`),
    await readFile(join(paths.dir, "index.json")),
  );
}
await revokeVersion(
  paths,
  "com.example.qualification",
  "1.0.1",
  "Disposable acceptance revocation",
);
await writeFile(join(out, "index-revoked.json"), await readFile(join(paths.dir, "index.json")));
await writeFile(join(out, "identity.json"), JSON.stringify(identity));
console.log("Disposable Linux app fixture prepared");
