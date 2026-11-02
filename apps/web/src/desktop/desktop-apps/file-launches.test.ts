import type { FileHandle } from "@everyos/app-sdk/protocol";
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../lib/api.ts";
import { createFileLaunches, resolveFileLaunch } from "./file-launches.ts";

const file: FileHandle = {
  id: "approved-video",
  name: "clip.mp4",
  kind: "file",
  size: 100,
  type: "video/mp4",
  writable: false,
  persistent: true,
};
const state = { type: "everyos.file-open", requestId: "request-one" };
describe("host-authorized file launches", () => {
  it("binds a one-use selection to its window, app, request and session", () => {
    const launches = createFileLaunches(() => "session");
    const location = { root: "home", path: "Videos/clip.mp4" };
    launches.queue("window", "video", "request", location);
    location.path = "other.mp4";
    expect(launches.take("other-window", "video", "request")).toBeNull();
    expect(launches.take("window", "other-app", "request")).toBeNull();
    expect(launches.take("window", "video", "forged-request")).toBeNull();
    expect(launches.take("window", "video", "request")).toEqual({
      root: "home",
      path: "Videos/clip.mp4",
    });
    expect(launches.take("window", "video", "request")).toBeNull();
  });
  it("expires pending selections and discards them when the account changes or locks", () => {
    let now = 0;
    let session: string | null = "first";
    const launches = createFileLaunches(
      () => session,
      () => now,
    );
    const queue = () =>
      launches.queue("window", "video", "request", { root: "home", path: "clip.mp4" });
    queue();
    now = 60_001;
    expect(launches.take("window", "video", "request")).toBeNull();
    queue();
    session = "second";
    expect(launches.take("window", "video", "request")).toBeNull();
    queue();
    session = null;
    expect(launches.take("window", "video", "request")).toBeNull();
    queue();
    session = "second";
    expect(launches.take("window", "video", "request")).toBeNull();
  });
  it("never grants paths supplied by an app or replayed from restored window state", async () => {
    const launches = createFileLaunches(() => "session");
    const grant = vi.fn();
    expect(
      await resolveFileLaunch(
        { ...state, root: "system", path: "etc/shadow" },
        "window",
        "video",
        grant,
        launches,
      ),
    ).toBeNull();
    expect(grant).not.toHaveBeenCalled();
  });
  it("hands the app approved handles without disclosing the host location", async () => {
    const launches = createFileLaunches(() => "session");
    launches.queue("window", "video", "request-one", { root: "home", path: "private/clip.mp4" });
    const grant = vi.fn(() => Promise.resolve([file]));
    const opened = await resolveFileLaunch(state, "window", "video", grant, launches);
    expect(opened).toEqual({ ...state, files: [file] });
    expect(grant).toHaveBeenCalledWith({ root: "home", path: "private/clip.mp4" });
    expect(JSON.stringify(opened)).not.toContain("private/");
    expect(await resolveFileLaunch(state, "window", "video", grant, launches)).toBeNull();
    expect(grant).toHaveBeenCalledTimes(1);
  });
  it("returns a safe error code when file access has been withdrawn", async () => {
    const launches = createFileLaunches(() => "session");
    launches.queue("window", "video", "request-one", { root: "home", path: "private/clip.mp4" });
    const result = await resolveFileLaunch(
      state,
      "window",
      "video",
      () => Promise.reject(new ApiRequestError(403, "FORBIDDEN", "private filesystem detail")),
      launches,
    );
    expect(result).toEqual({ ...state, error: "FORBIDDEN" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
