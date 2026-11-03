import type { MockHostOptions } from "@everyos/app-testing";

/** An already consented read-only file, as delivered by the desktop. */
export function fileOpenOptions(name: string, bytes: string | Uint8Array): MockHostOptions {
  return {
    files: { [`/${name}`]: bytes },
    handles: [{ id: "selected", path: `/${name}`, kind: "file", writable: false }],
    state: {
      type: "everyos.file-open",
      requestId: "selected-request",
      files: [
        {
          id: "selected",
          name,
          kind: "file",
          size: typeof bytes === "string" ? new TextEncoder().encode(bytes).length : bytes.length,
          type: null,
          writable: false,
          persistent: true,
        },
      ],
    },
  };
}
