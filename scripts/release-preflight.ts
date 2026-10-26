import { readFile } from "node:fs/promises";
import { COMMUNITY_APP_REGISTRY } from "../apps/api/src/modules/desktop-apps/anchors.ts";
import { checkCommunityRelease } from "./community-release-gate.ts";
import { inspectCommunityDeployment } from "./community-deployment.ts";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as {
  version: string;
};
// Fail before reading evidence or making network requests when deployment is still pending.
if (!COMMUNITY_APP_REGISTRY) checkCommunityRelease(null, null, version);
const evidence: unknown = JSON.parse(
  await readFile(new URL("packaging/community-live-acceptance.json", root), "utf8"),
);
checkCommunityRelease(COMMUNITY_APP_REGISTRY, evidence, version);
if (COMMUNITY_APP_REGISTRY) {
  await inspectCommunityDeployment(COMMUNITY_APP_REGISTRY.publicKey);
}
console.log("Public release preflight passed");
