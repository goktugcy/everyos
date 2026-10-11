import { DEFAULT_APPEARANCE } from "@everyos/theme";
import { expect, it, vi } from "vitest";
import { relocateFolderIcons } from "./folder-icon-ops.ts";

vi.mock("../../stores/session-store.ts", () => ({ useSessionStore: vi.fn() }));
vi.mock("./preferences-store.ts", () => ({ updatePreference: vi.fn(), usePreferences: vi.fn() }));

it("carries folder and descendant icons across roots without touching similarly named siblings", () => {
  const current = {
    ...DEFAULT_APPEARANCE,
    folderIcons: [
      {
        root: "home",
        path: "Desktop/Work",
        icon: { kind: "preset" as const, id: "green" as const },
      },
      {
        root: "home",
        path: "Desktop/Work/Notes",
        icon: { kind: "uploaded" as const, iconId: "image1" },
      },
      {
        root: "home",
        path: "Desktop/Workshop",
        icon: { kind: "preset" as const, id: "amber" as const },
      },
    ],
  };
  const from = { root: "home", path: "Desktop/Work" };
  const to = { root: "data", path: "Archives/Work" };
  const moved = relocateFolderIcons(current, from, to, false);
  expect(moved.folderIcons?.map((item) => `${item.root}/${item.path}`)).toEqual([
    "home/Desktop/Workshop",
    "data/Archives/Work",
    "data/Archives/Work/Notes",
  ]);
  expect(moved.folderIcons?.find((item) => item.path.endsWith("/Notes"))?.icon).toEqual({
    kind: "uploaded",
    iconId: "image1",
  });
  const copied = relocateFolderIcons(current, from, to, true);
  expect(copied.folderIcons).toHaveLength(5);
  expect(current.folderIcons).toHaveLength(3);
});
