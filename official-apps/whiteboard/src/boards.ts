import type { EveryOSApp } from "@everyos/app-sdk";

/*
 * Boards in the app's per-person storage. A board's scene (Excalidraw JSON, images included) is
 * gzip-compressed and written as base64 in chunks, since one storage value holds 256 KiB; the
 * list of boards is a value of its own.
 */

export interface Board {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Stored size (compressed), to warn before the app's storage fills up. */
  bytes: number;
  chunks: number;
}

/** Characters per stored chunk: base64 is plain ASCII, so this many bytes and no escaping. */
export const CHUNK_CHARS = 200_000;
/** Boards larger than this (compressed) are not kept; the person is asked to export instead. */
export const MAX_BOARD_BYTES = 12 * 1024 * 1024;
export const MAX_BOARDS = 200;

export class BoardTooLargeError extends Error {}

/** A stash (a scene written while the window closes) goes out in at most this many requests. */
export const MAX_STASH_CHUNKS = 20;
const STASH_VALUE_BYTES = 240 * 1024;

/**
 * Splits text into pieces whose JSON form stays under a storage value's size (escaped quotes and
 * multi-byte characters included); null when that takes more than `limit` pieces.
 */
export function splitForStorage(text: string, limit: number): string[] | null {
  const encoder = new TextEncoder();
  let size = 60_000;
  for (let attempt = 0; attempt < 4; attempt += 1, size = Math.floor(size / 2)) {
    const pieces: string[] = [];
    let index = 0;
    while (index < text.length) {
      let end = Math.min(text.length, index + size);
      // Never split a surrogate pair.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
      pieces.push(text.slice(index, end));
      index = end;
    }
    if (pieces.length > limit) return null;
    if (pieces.every((piece) => encoder.encode(JSON.stringify(piece)).length <= STASH_VALUE_BYTES))
      return pieces;
  }
  return null;
}

const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const output = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function pack(json: string): Promise<string> {
  return toBase64(await transform(new TextEncoder().encode(json), new CompressionStream("gzip")));
}

export async function unpack(packed: string): Promise<string> {
  return new TextDecoder().decode(
    await transform(fromBase64(packed), new DecompressionStream("gzip")),
  );
}

const chunkKey = (id: string, index: number) => `board/${id}/${index}`;

const isBoard = (value: unknown): value is Board => {
  const board = value as Board | null;
  return (
    !!board &&
    typeof board.id === "string" &&
    /^[\w-]{1,64}$/.test(board.id) &&
    typeof board.name === "string" &&
    typeof board.updatedAt === "number" &&
    Number.isInteger(board.chunks) &&
    board.chunks >= 0
  );
};

export class BoardStore {
  readonly #app: EveryOSApp;
  readonly #now: () => number;
  readonly #maxBytes: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    app: EveryOSApp,
    now: () => number = () => Date.now(),
    maxBytes: number = MAX_BOARD_BYTES,
  ) {
    this.#app = app;
    this.#now = now;
    this.#maxBytes = maxBytes;
  }

  #serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<Board[]> {
    const stored = await this.#app.storage.get<unknown[]>("boards");
    return (Array.isArray(stored) ? stored : []).filter(isBoard).map((board) => ({
      ...board,
      name: board.name.slice(0, 120),
      createdAt: typeof board.createdAt === "number" ? board.createdAt : board.updatedAt,
      bytes: typeof board.bytes === "number" ? board.bytes : 0,
    }));
  }

  #saveList(boards: Board[]): Promise<void> {
    return this.#app.storage.set("boards", boards.slice(0, MAX_BOARDS));
  }

  create(name: string): Promise<Board> {
    return this.#serially(async () => {
      const boards = await this.list();
      const board: Board = {
        id: randomId(),
        name: name.trim().slice(0, 120),
        createdAt: this.#now(),
        updatedAt: this.#now(),
        bytes: 0,
        chunks: 0,
      };
      await this.#saveList([board, ...boards]);
      return board;
    });
  }

  /** The boards, with a first one named `name` made if there is none (once, even when asked twice). */
  ensureOne(name: string): Promise<Board[]> {
    return this.#serially(async () => {
      const boards = await this.list();
      if (boards.length) return boards;
      const board: Board = {
        id: randomId(),
        name: name.trim().slice(0, 120),
        createdAt: this.#now(),
        updatedAt: this.#now(),
        bytes: 0,
        chunks: 0,
      };
      await this.#saveList([board]);
      return [board];
    });
  }

  rename(id: string, name: string): Promise<void> {
    return this.#serially(async () => {
      const boards = await this.list();
      await this.#saveList(
        boards.map((board) =>
          board.id === id ? { ...board, name: name.trim().slice(0, 120) } : board,
        ),
      );
    });
  }

  /** The board's scene as Excalidraw JSON, or null for a board never drawn on. */
  async load(id: string): Promise<string | null> {
    const board = (await this.list()).find((entry) => entry.id === id);
    if (!board || board.chunks === 0) return null;
    const parts = await Promise.all(
      Array.from({ length: board.chunks }, (_, index) =>
        this.#app.storage.get<string>(chunkKey(id, index)),
      ),
    );
    if (parts.some((part) => typeof part !== "string"))
      throw new Error("A part of the board is missing");
    return unpack(parts.join(""));
  }

  /** Stores a board's scene; refuses scenes too large to keep. */
  save(id: string, json: string): Promise<Board> {
    return this.#serially(() => this.#write(id, json));
  }

  async #write(id: string, json: string): Promise<Board> {
    const packed = await pack(json);
    if (packed.length > this.#maxBytes) throw new BoardTooLargeError(String(packed.length));
    const boards = await this.list();
    const board = boards.find((entry) => entry.id === id);
    if (!board) throw new Error("No such board");
    const chunks = Math.ceil(packed.length / CHUNK_CHARS);
    for (let index = 0; index < chunks; index += 1)
      await this.#app.storage.set(
        chunkKey(id, index),
        packed.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS),
      );
    // Chunks left over from a larger version.
    for (let index = chunks; index < board.chunks; index += 1)
      await this.#app.storage.delete(chunkKey(id, index));
    const updated = { ...board, updatedAt: this.#now(), bytes: packed.length, chunks };
    await this.#saveList(boards.map((entry) => (entry.id === id ? updated : entry)));
    return updated;
  }

  /**
   * Writes a scene right away, uncompressed, while the window closes (there is no time left to
   * compress it): every request leaves before the page goes. False when it is too large for that.
   */
  stash(id: string, json: string): boolean {
    const pieces = splitForStorage(json, MAX_STASH_CHUNKS);
    if (!pieces) return false;
    pieces.forEach(
      (piece, index) => void this.#app.storage.set(`stash/${index}`, piece).catch(() => undefined),
    );
    void this.#app.storage
      .set("stash", { id, chunks: pieces.length, at: this.#now() })
      .catch(() => undefined);
    return true;
  }

  /** Puts a scene stashed by a closing window into its board; returns the board's id. */
  recover(): Promise<string | null> {
    return this.#serially(async () => {
      const stash = await this.#app.storage.get<{ id?: unknown; chunks?: unknown }>("stash");
      if (!stash) return null;
      const chunks = Number.isInteger(stash.chunks)
        ? Math.min(Number(stash.chunks), MAX_STASH_CHUNKS)
        : 0;
      const parts = await Promise.all(
        Array.from({ length: chunks }, (_, index) => this.#app.storage.get(`stash/${index}`)),
      );
      let recovered: string | null = null;
      const json = parts.every((part): part is string => typeof part === "string")
        ? parts.join("")
        : null;
      const boards = await this.list();
      if (json && typeof stash.id === "string" && boards.some((board) => board.id === stash.id)) {
        try {
          JSON.parse(json);
          recovered = stash.id;
        } catch {
          recovered = null;
        }
      }
      for (let index = 0; index < MAX_STASH_CHUNKS; index += 1)
        await this.#app.storage.delete(`stash/${index}`).catch(() => undefined);
      await this.#app.storage.delete("stash");
      if (recovered && json) await this.#write(recovered, json);
      return recovered;
    });
  }

  remove(id: string): Promise<void> {
    return this.#serially(async () => {
      const boards = await this.list();
      const board = boards.find((entry) => entry.id === id);
      await this.#saveList(boards.filter((entry) => entry.id !== id));
      for (let index = 0; index < (board?.chunks ?? 0); index += 1)
        await this.#app.storage.delete(chunkKey(id, index));
    });
  }

  async duplicate(id: string, name: string): Promise<Board> {
    const scene = await this.load(id);
    const copy = await this.create(name);
    return scene ? this.save(copy.id, scene) : copy;
  }
}
