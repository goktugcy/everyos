import { crc32, deflateSync } from "node:zlib";

/** A synthetic, real decodable RGB image used only by browser workflows. */
export function makeImage(
  width: number,
  height: number,
  color: [number, number, number],
  cameraMake?: string,
): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let n = 0; n < width; n++) {
    row[1 + n * 3] = color[0];
    row[2 + n * 3] = color[1];
    row[3 + n * 3] = color[2];
  }
  const metadata: Buffer[] = [];
  if (cameraMake) {
    const value = Buffer.from(`${cameraMake}\0`, "ascii");
    const tiff = Buffer.alloc(26 + value.length);
    tiff.write("II");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x010f, 10);
    tiff.writeUInt16LE(2, 12);
    tiff.writeUInt32LE(value.length, 14);
    tiff.writeUInt32LE(26, 18);
    value.copy(tiff, 26);
    metadata.push(chunk("eXIf", tiff));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...metadata,
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
