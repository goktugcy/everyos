import { describe, expect, it } from "vitest";
import { imageMetadata, imagePreferences, isImage, rotated, zoomed } from "../src/images.ts";

describe("Image data", () => {
  it("bounds restored file references and slide timing without accepting paths or temporary URLs", () => {
    const restored = imagePreferences({
      ids: ["h1", "h1", "../private", "https://remote", 2],
      current: "h2",
      interval: 1,
    });
    expect(restored).toEqual({ ids: ["h1"], current: "h1", interval: 5000 });
    expect(
      imagePreferences({ ids: Array.from({ length: 150 }, (_, n) => `h${n}`), interval: 10000 })
        .ids,
    ).toHaveLength(100);
    expect(imagePreferences(null).ids).toEqual([]);
  });
  it("accepts common image extensions only on files", () => {
    expect(isImage({ kind: "file", name: "photo.JPEG" })).toBe(true);
    expect(isImage({ kind: "directory", name: "photo.png" })).toBe(false);
    expect(isImage({ kind: "file", name: "photo.png.exe" })).toBe(false);
  });
  it("distinguishes missing EXIF from a damaged metadata stream", async () => {
    expect(await imageMetadata(new TextEncoder().encode("<svg/>").buffer, "shape.svg")).toEqual({
      tags: [],
      failed: false,
    });
    expect(await imageMetadata(new Uint8Array([1, 2, 3]).buffer, "damaged.jpg")).toEqual({
      tags: [],
      failed: true,
    });
  });
  it("keeps zoom and rotation bounded", () => {
    expect(zoomed(100)).toBe(8);
    expect(zoomed(-1)).toBe(0.1);
    expect(rotated(-90)).toBe(270);
    expect(rotated(450)).toBe(90);
  });
});
