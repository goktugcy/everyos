/** Re-chunks a byte stream into `size`-byte pieces (the last one may be shorter). */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Buffer, void, undefined> {
  let pending: Buffer[] = [];
  let length = 0;
  for await (const data of source) {
    let chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    while (length + chunk.length >= size) {
      const take = size - length;
      pending.push(chunk.subarray(0, take));
      yield Buffer.concat(pending);
      chunk = chunk.subarray(take);
      pending = [];
      length = 0;
    }
    if (chunk.length) {
      pending.push(Buffer.from(chunk));
      length += chunk.length;
    }
  }
  if (length) yield Buffer.concat(pending);
}
