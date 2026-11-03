export interface CsvSettings {
  delimiter: "," | ";" | "\t";
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  bom: boolean;
  newline: "\r\n" | "\n" | "\r";
  trailingNewline: boolean;
  separatorLine: boolean;
}

export function isCsvSettings(value: unknown): value is CsvSettings {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    [",", ";", "\t"].includes(String(item.delimiter)) &&
    ["utf-8", "utf-16le", "utf-16be"].includes(String(item.encoding)) &&
    ["\r\n", "\n", "\r"].includes(String(item.newline)) &&
    typeof item.bom === "boolean" &&
    typeof item.trailingNewline === "boolean" &&
    typeof item.separatorLine === "boolean"
  );
}
