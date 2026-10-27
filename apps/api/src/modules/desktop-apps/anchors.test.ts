import { keyFingerprint } from "@everyos/app-package";
import { expect, it } from "vitest";
import { COMMUNITY_APP_REGISTRY, OFFICIAL_APP_REGISTRY } from "./anchors.ts";

it("pins the official release index to the owner's Ed25519 key", () => {
  expect(OFFICIAL_APP_REGISTRY.url).toBe(
    "https://github.com/goktugcy/everyos/releases/latest/download/official-apps.json",
  );
  expect(keyFingerprint(OFFICIAL_APP_REGISTRY.publicKey)).toBe(
    "sha256:d0670c89bb20001940869994f8c59e10dfa44c552115a2e06496b47ff1ae5852",
  );
  expect(OFFICIAL_APP_REGISTRY.allowPrivate).toBeUndefined();
});

it("pins the human-reviewed live community service to its independently retained key", () => {
  expect(COMMUNITY_APP_REGISTRY.url).toBe("https://registry.everyos.net/index.json");
  expect(keyFingerprint(COMMUNITY_APP_REGISTRY.publicKey)).toBe(
    "sha256:424cf75d70fcf7b9711cf5ed9ed1e436a8602e42c868379c17c66a0fd7847ddf",
  );
  expect(COMMUNITY_APP_REGISTRY.allowPrivate).toBeUndefined();
});
