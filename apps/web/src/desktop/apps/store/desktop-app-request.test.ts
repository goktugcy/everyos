import type { DesktopAppInstallationView, DesktopAppListing } from "@everyos/shared";
import { describe, expect, it } from "vitest";
import { readDesktopAppRequest, requestedDesktopApp } from "./desktop-app-request.ts";

const request = { appId: "dev.everyos.video", registryId: "official", requestId: "request-one" };
const listing: DesktopAppListing = {
  appId: request.appId,
  registry: { id: "official", kind: "official", name: "EveryOS" },
  publisher: { id: "dev.everyos", name: "EveryOS", url: null },
  name: "Video Player",
  description: "Video",
  category: "media",
  version: "1.0.1",
  license: "MIT",
  homepage: null,
  source: null,
  permissions: [],
  widgets: 0,
  locales: ["en"],
  versions: [],
  screenshots: 0,
  incompatible: null,
  revoked: null,
  conflict: false,
  installed: null,
  updateAvailable: null,
};
const installation: DesktopAppInstallationView = {
  appId: request.appId,
  registry: listing.registry,
  publisher: { id: "dev.everyos", name: "EveryOS" },
  name: "Video Player",
  description: "Video",
  category: "media",
  version: "1.0.1",
  runtimeUrl: "/app-runtime/test/",
  entry: "index.html",
  icon: "icon.svg",
  window: {
    defaultWidth: 800,
    defaultHeight: 600,
    minWidth: 360,
    minHeight: 320,
    instances: "single",
  },
  widgets: [],
  locales: null,
  permissions: [],
  state: "active",
  stateReason: null,
  installedAt: 1,
  updatedAt: 1,
};
describe("App Store installation requests", () => {
  it("reads bounded app and registry identities without carrying file locations", () => {
    expect(readDesktopAppRequest({ ...request, root: "home", path: "private/a.mp4" })).toEqual(
      request,
    );
    expect(readDesktopAppRequest(null)).toBeNull();
    expect(readDesktopAppRequest({ ...request, appId: "../../file" })).toBeNull();
    expect(readDesktopAppRequest({ ...request, registryId: "https://elsewhere" })).toBeNull();
    expect(readDesktopAppRequest({ ...request, requestId: "" })).toBeNull();
  });
  it("selects the requested official catalog record regardless of listing order", () => {
    const otherSource = {
      ...listing,
      registry: { id: "private", kind: "private" as const, name: "Private" },
    };
    expect(requestedDesktopApp(request, [otherSource, listing], [])).toEqual({
      listing,
      installation: null,
    });
    expect(requestedDesktopApp(request, [otherSource], [])).toBeNull();
  });
  it("never combines an official offer with an installation from another source", () => {
    const privateInstallation = {
      ...installation,
      registry: { id: "private", kind: "private" as const, name: "Private" },
    };
    expect(requestedDesktopApp(request, [listing], [privateInstallation])).toEqual({
      listing,
      installation: null,
    });
    expect(requestedDesktopApp(request, [], [installation])).toEqual({
      listing: null,
      installation,
    });
  });
});
