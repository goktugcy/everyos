import { startWorker } from "@everyos/app-ui";
import {
  MAX_OFFICE_BYTES,
  OfficeError,
  type OfficeFormat,
  type OfficeErrorCode,
} from "./container.ts";
import { isCsvSettings, type CsvSettings } from "./csv-format.ts";

interface OfficeResult {
  bytes: Uint8Array;
  legacy: boolean;
  csv: CsvSettings | null;
  sheets: number;
}

export async function prepareOfficeFile(
  format: OfficeFormat,
  name: string,
  bytes: Uint8Array,
  labels: Record<string, string>,
  signal?: AbortSignal,
): Promise<OfficeResult> {
  return runWorker(format, name, bytes, labels, signal);
}

export function prepareCsvSave(bytes: Uint8Array, csv: CsvSettings): Promise<OfficeResult> {
  return runWorker("xlsx", "", bytes, {}, undefined, csv);
}

async function runWorker(
  format: OfficeFormat,
  name: string,
  bytes: Uint8Array,
  labels: Record<string, string>,
  signal?: AbortSignal,
  csv?: CsvSettings,
): Promise<OfficeResult> {
  if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
  signal?.throwIfAborted();
  const worker = await startWorker("office-worker.js");
  return new Promise((resolve, reject) => {
    let finished = false;
    const end = (error?: unknown, result?: OfficeResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error !== undefined) reject(error instanceof Error ? error : new OfficeError("invalid"));
      else if (result) resolve(result);
    };
    const abort = () => end(signal?.reason ?? new OfficeError("timeout"));
    const timer = setTimeout(() => end(new OfficeError("timeout")), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as {
        ok?: unknown;
        bytes?: unknown;
        legacy?: unknown;
        code?: unknown;
        csv?: unknown;
        sheets?: unknown;
      } | null;
      if (
        data?.ok === true &&
        data.bytes instanceof Uint8Array &&
        typeof data.legacy === "boolean" &&
        (data.csv === null || isCsvSettings(data.csv)) &&
        typeof data.sheets === "number" &&
        Number.isSafeInteger(data.sheets) &&
        data.sheets > 0
      ) {
        if (data.bytes.length > MAX_OFFICE_BYTES) end(new OfficeError("tooLarge"));
        else
          end(undefined, {
            bytes: data.bytes,
            legacy: data.legacy,
            csv: data.csv,
            sheets: data.sheets,
          });
      } else {
        const code =
          typeof data?.code === "string" &&
          ["invalid", "tooLarge", "encrypted", "timeout", "conversion"].includes(data.code)
            ? (data.code as OfficeErrorCode)
            : "invalid";
        end(new OfficeError(code));
      }
    };
    worker.onerror = () => end(new OfficeError("invalid"));
    if (signal?.aborted) return abort();
    const transferable = new Uint8Array(bytes);
    worker.postMessage(
      { format, name, bytes: transferable, labels, ...(csv ? { mode: "csv-save", csv } : {}) },
      [transferable.buffer],
    );
  });
}
