/**
 * Newline-delimited JSON framing. `JSON.stringify` never emits raw newlines,
 * so a single `\n` unambiguously terminates each message. A hard per-line
 * limit protects both ends from unbounded buffering.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * Agent → API frames may be larger (a full service list or a page of long log
 * lines). The agent refuses to send anything above this limit.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class FrameTooLargeError extends Error {
  constructor(limit: number) {
    super(`Protocol message exceeds ${limit} bytes`);
    this.name = "FrameTooLargeError";
  }
}

export class LineDecoder {
  readonly #maxBytes: number;
  #chunks: Buffer[] = [];
  #buffered = 0;

  constructor(maxBytes = DEFAULT_MAX_MESSAGE_BYTES) {
    this.#maxBytes = maxBytes;
  }

  /** Feeds raw bytes and returns every complete line they finish. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    let index = chunk.indexOf(0x0a, start);
    while (index !== -1) {
      const part = chunk.subarray(start, index);
      if (this.#buffered + part.length > this.#maxBytes)
        throw new FrameTooLargeError(this.#maxBytes);
      this.#chunks.push(part);
      lines.push(Buffer.concat(this.#chunks).toString("utf8"));
      this.#chunks = [];
      this.#buffered = 0;
      start = index + 1;
      index = chunk.indexOf(0x0a, start);
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      this.#buffered += rest.length;
      if (this.#buffered > this.#maxBytes) throw new FrameTooLargeError(this.#maxBytes);
      this.#chunks.push(Buffer.from(rest));
    }
    return lines;
  }
}

export function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
