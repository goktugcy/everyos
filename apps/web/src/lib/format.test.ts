import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "./format.ts";

describe("format helpers", () => {
  it("formats bytes with binary units", () => {
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(8 * 1024 ** 3, "en")).toBe("8 GiB");
    expect(formatBytes(1536, "en")).toBe("1.5 KiB");
    expect(formatBytes(1536, "tr")).toBe("1,5 KiB");
  });

  it("formats durations compactly in each language", () => {
    expect(formatDuration(3 * 86_400 + 4 * 3_600 + 5 * 60, "en")).toMatch(/^3 days? 4 hr/);
    expect(formatDuration(3 * 86_400 + 4 * 3_600, "tr")).toBe("3 gün 4 sa.");
    expect(formatDuration(30, "en")).toMatch(/^0 min/);
  });
});
