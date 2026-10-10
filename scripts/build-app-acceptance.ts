import { build } from "esbuild";

// Stage a dependency-free harness for a disposable Linux runtime with Node and the Docker CLI.
await build({
  entryPoints: ["scripts/accept-app-store.ts"],
  outfile: "dist/accept-app-store.mjs",
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  banner: {
    js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
