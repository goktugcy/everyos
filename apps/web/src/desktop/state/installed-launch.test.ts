import type { InstalledAppView, Permission } from "@everyos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../lib/api.ts";
import {
  clearInstalledApps,
  installedAppId,
  rememberInstalledApps,
  useInstalledApps,
} from "../apps/store/installed-apps-store.ts";
import { desktop } from "./controller.ts";

const session = vi.hoisted(() => ({
  id: "session-a",
  locked: false,
  permissions: ["apps:read"] as Permission[],
}));
const openWindow = vi.hoisted(() => vi.fn(() => "details-window"));
vi.mock("../../lib/api.ts", () => ({ api: vi.fn() }));
vi.mock("../../stores/session-store.ts", () => ({
  useSessionStore: {
    getState: () => ({
      session: { session: { id: session.id }, permissions: session.permissions },
      locked: session.locked,
    }),
  },
}));
vi.mock("./window-store.ts", () => ({ wm: () => ({ open: openWindow }) }));
vi.mock("./preferences-store.ts", () => ({ usePreferences: { getState: vi.fn() } }));

const app: InstalledAppView = {
  id: "f67d5b64-3b22-47b5-b957-aee0a821498a",
  name: { en: "Example app" },
  project: "example-project",
  provenance: {
    catalogId: "test-catalog",
    format: "compose-dir",
    ref: "test-ref",
    path: "example",
  },
  source: "host",
  state: "running",
  lastError: null,
  installedAt: 1,
  images: [],
  web: { scheme: "http", path: "/old" },
  ports: [{ port: 8080, hostIp: "0.0.0.0" }],
  lastJob: null,
  dataCopyEligible: false,
  widgetAdapters: [],
  configurable: true,
  catalogUpdate: null,
};
const popup = {
  opener: {} as unknown,
  closed: false,
  close: vi.fn(),
  location: { replace: vi.fn() },
};
const openTab = vi.fn(() => popup);

beforeEach(() => {
  vi.clearAllMocks();
  session.id = "session-a";
  session.locked = false;
  session.permissions = ["apps:read"];
  popup.opener = {};
  vi.stubGlobal("window", { open: openTab, location: { hostname: "server.example" } });
  rememberInstalledApps([app]);
});
afterEach(() => {
  clearInstalledApps();
  vi.unstubAllGlobals();
});

describe("managed application shortcut launch", () => {
  it("resolves current published ports and path instead of navigating to the cached endpoint", async () => {
    vi.mocked(api).mockResolvedValue({
      apps: [
        {
          ...app,
          ports: [{ port: 8091, hostIp: "0.0.0.0" }],
          web: { scheme: "https", path: "/new" },
        },
      ],
    });
    desktop.openApp(installedAppId(app.id));
    expect(openTab).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    await vi.waitFor(() =>
      expect(popup.location.replace).toHaveBeenCalledWith("https://server.example:8091/new"),
    );
    expect(openWindow).not.toHaveBeenCalled();
  });

  it.each(["lock", "sign-out", "permission-change"])(
    "closes the reserved tab after a pending %s",
    async (change) => {
      const response = Promise.withResolvers<{ apps: InstalledAppView[] }>();
      vi.mocked(api).mockReturnValue(response.promise);
      desktop.openApp(installedAppId(app.id));
      if (change === "lock") session.locked = true;
      else if (change === "sign-out") session.id = "session-b";
      else session.permissions = [];
      response.resolve({ apps: [{ ...app, ports: [] }] });
      await vi.waitFor(() => expect(popup.close).toHaveBeenCalled());
      expect(popup.location.replace).not.toHaveBeenCalled();
      expect(openWindow).not.toHaveBeenCalled();
      expect(useInstalledApps.getState().apps[0]?.ports).toEqual(app.ports);
    },
  );

  it("opens management details for simulated applications without a popup or start action", async () => {
    const simulated = { ...app, source: "simulated" as const };
    rememberInstalledApps([simulated]);
    vi.mocked(api).mockResolvedValue({ apps: [simulated] });
    desktop.openApp(installedAppId(app.id));
    await vi.waitFor(() =>
      expect(openWindow).toHaveBeenCalledWith(
        expect.objectContaining({ appId: "everyos.applications" }),
        { appState: { applicationId: app.id } },
      ),
    );
    expect(openTab).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledExactlyOnceWith("/apps");
  });
});
