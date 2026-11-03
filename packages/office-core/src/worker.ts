import {
  MAX_OFFICE_BYTES,
  OfficeError,
  validateOfficeZip,
  type OfficeFormat,
} from "./container.ts";
import { convertLegacyDoc, convertLegacyWorkbook } from "./legacy.ts";
import { exportCsv, importCsv } from "./csv.ts";
import { isCsvSettings, type CsvSettings } from "./csv-format.ts";

export interface OfficeRequest {
  format: OfficeFormat;
  name: string;
  bytes: Uint8Array;
  labels: Record<string, string>;
  mode?: "open" | "csv-save";
  csv?: CsvSettings;
}

declare const self: {
  onmessage: ((event: MessageEvent<OfficeRequest>) => void) | null;
  postMessage: (value: unknown, transfer?: Transferable[]) => void;
};

/** Only installed app code runs here; input is bounded data and the host terminates slow parsing. */
export function serveOfficeWorker(): void {
  self.onmessage = (event) => {
    void (async () => {
      try {
        const { format, name, bytes, labels } = event.data;
        if (
          !["docx", "xlsx"].includes(format) ||
          typeof name !== "string" ||
          !(bytes instanceof Uint8Array)
        )
          throw new OfficeError("invalid");
        if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
        if (event.data.mode === "csv-save") {
          if (format !== "xlsx" || !isCsvSettings(event.data.csv)) throw new OfficeError("invalid");
          await validateOfficeZip(bytes, "xlsx");
          const result = exportCsv(bytes, event.data.csv);
          self.postMessage({ ok: true, ...result, legacy: false, csv: event.data.csv }, [
            result.bytes.buffer,
          ]);
          return;
        }
        const legacy = format === "docx" ? /\.doc$/i.test(name) : /\.xls$/i.test(name);
        const csv =
          format === "xlsx" && /\.csv$/i.test(name)
            ? importCsv(bytes, labels.sheetName ?? "Sheet1")
            : null;
        const result = csv
          ? csv.bytes
          : legacy
            ? format === "docx"
              ? await convertLegacyDoc(bytes, labels)
              : convertLegacyWorkbook(bytes)
            : bytes;
        await validateOfficeZip(result, format);
        const output = new Uint8Array(result);
        self.postMessage(
          { ok: true, bytes: output, legacy, csv: csv?.settings ?? null, sheets: 1 },
          [output.buffer],
        );
      } catch (error) {
        self.postMessage({
          ok: false,
          code: error instanceof OfficeError ? error.code : "invalid",
        });
      }
    })();
  };
}
