import { describe, expect, it } from "vitest";
import { captions, isVideo, mimeOfVideo, resumePosition, videoPreferences } from "../src/video.ts";

describe("Video state and captions", () => {
  it("restores bounded lists, settings and positions, excluding unknown handles and temporary URLs", () => {
    const state = videoPreferences({
      lists: [{ id: "list", name: " Work\n", ids: ["h1", "h1", "../outside", "https://remote"] }],
      list: "list",
      current: "h1",
      positions: { h1: { seconds: 12, at: 1 }, outside: { seconds: 2, at: 1 } },
      subtitles: { h1: "s1", outside: "s2" },
      rate: 100,
      volume: -2,
    });
    expect(state.lists[0]).toEqual({ id: "list", name: "Work", ids: ["h1"] });
    expect(state.positions).toEqual({ h1: { seconds: 12, at: 1 } });
    expect(state.subtitles).toEqual({ h1: "s1" });
    expect(state.rate).toBe(1);
    expect(state.volume).toBe(1);
    expect(videoPreferences(null).lists[0]!.id).toBe("default");
    const lists = Array.from({ length: 30 }, (_, n) => ({
      id: `l${n}`,
      name: "x".repeat(100),
      ids: Array.from({ length: 150 }, (_, i) => `h${i}`),
    }));
    expect(videoPreferences({ lists }).lists).toHaveLength(20);
    expect(videoPreferences({ lists }).lists[0]!.ids).toHaveLength(100);
  });
  it("parses timed WebVTT/SRT without executing markup, styles or invalid timing", () => {
    expect(captions("1\n00:00:01,000 --> 00:00:02,500\nHello")).toEqual([
      { start: 1, end: 2.5, text: "Hello" },
    ]);
    const value =
      "WEBVTT\n\nSTYLE\n::cue { color: red }\n\nNOTE comment\nignored\n\ncue\n00:01.000 --> 00:02.000 align:start\n<script>alert(1)</script>\n\n00:99.000 --> 01:00.000\nbad";
    expect(captions(value)).toEqual([
      { start: 1, end: 2, text: "&lt;script&gt;alert(1)&lt;/script&gt;" },
    ]);
    expect(() => captions("not timed text")).toThrow("invalid-subtitles");
    expect(() =>
      captions(Array.from({ length: 2001 }, () => "00:01.000 --> 00:02.000\nx").join("\n\n")),
    ).toThrow("subtitle-limit");
  });
  it("uses native codec hints and bounds resume offsets without claiming transcoding", () => {
    expect(isVideo("movie.WEBM")).toBe(true);
    expect(isVideo("movie.mp4.exe")).toBe(false);
    expect(mimeOfVideo("movie.webm")).toBe("video/webm");
    expect(mimeOfVideo("movie.avi")).toBe("video/x-msvideo");
    expect(resumePosition(Infinity, 10)).toBe(0);
    expect(resumePosition(-2, 10)).toBe(0);
    expect(resumePosition(12, 10)).toBe(9.9);
    expect(resumePosition(3, Infinity)).toBe(3);
  });
});
