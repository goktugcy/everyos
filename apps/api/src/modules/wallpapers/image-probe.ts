import type { WallpaperMimeType } from "@otuken/shared";

export interface ImageInfo {
  mime: WallpaperMimeType;
  width: number;
  height: number;
}

/**
 * Identifies JPEG, PNG and WebP images from their header bytes and reads
 * their pixel dimensions without decoding them. The declared Content-Type is
 * never trusted; SVG and anything else is rejected (SVG can carry scripts).
 */
export function probeImage(header: Buffer): ImageInfo | null {
  return probePng(header) ?? probeJpeg(header) ?? probeWebp(header);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function probePng(buf: Buffer): ImageInfo | null {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function probeJpeg(buf: Buffer): ImageInfo | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Standalone markers without a length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // SOF0–SOF15 carry dimensions (C4 = DHT, C8 = JPG, CC = DAC are not frames).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        mime: "image/jpeg",
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end without a frame header
    offset += 2 + length;
  }
  return null;
}

function probeWebp(buf: Buffer): ImageInfo | null {
  if (
    buf.length < 30 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // Frame tag (3 bytes) then the start code 9d 01 2a.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      mime: "image/webp",
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return {
      mime: "image/webp",
      width: buf.readUIntLE(24, 3) + 1,
      height: buf.readUIntLE(27, 3) + 1,
    };
  }
  return null;
}
