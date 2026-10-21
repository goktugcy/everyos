import { isBridgeError, type EveryOSApp, type FileHandle } from "@everyos/app-sdk";
import type { Translate } from "./app.tsx";

/*
 * Import and export through EveryOS's own file picker: the app gets exactly the files the person
 * picks, nothing else (needs files:pick to open, files:save to save).
 */

export interface OpenedText {
  handle: FileHandle;
  name: string;
  text: string;
}

/** Lets the person pick a text file and reads it; null when they cancel. */
export async function openTextFile(
  app: EveryOSApp,
  options: { accept?: string[]; maxBytes?: number } = {},
): Promise<OpenedText | null> {
  const [handle] = await app.files.open({ accept: options.accept ?? [] });
  if (!handle) return null;
  if (options.maxBytes && handle.size !== null && handle.size > options.maxBytes)
    throw new RangeError(`too-large:${options.maxBytes}`);
  return { handle, name: handle.name, text: await app.files.readText(handle) };
}

/** Opens several files of the person's choice (bytes), e.g. images or audio. */
export async function openFiles(
  app: EveryOSApp,
  options: { accept?: string[]; multiple?: boolean; persist?: boolean } = {},
): Promise<FileHandle[]> {
  return app.files.open({
    accept: options.accept ?? [],
    multiple: options.multiple ?? true,
    persist: options.persist ?? false,
  });
}

/** Lets the person choose where to save, then writes; null when they cancel. */
export async function saveTextFile(
  app: EveryOSApp,
  suggestedName: string,
  text: string | Uint8Array,
  options: { accept?: string[]; handle?: FileHandle | null } = {},
): Promise<FileHandle | null> {
  const handle =
    options.handle && options.handle.writable
      ? options.handle
      : await app.files.save({ suggestedName, accept: options.accept ?? [] });
  if (!handle) return null;
  await app.files.write(handle, text);
  return handle;
}

export async function exportJson(
  app: EveryOSApp,
  suggestedName: string,
  value: unknown,
): Promise<FileHandle | null> {
  return saveTextFile(app, suggestedName, `${JSON.stringify(value, null, 2)}\n`, {
    accept: [".json"],
  });
}

/** Parses a JSON file the person picks; `check` validates its shape (throw to refuse). */
export async function importJson<T>(
  app: EveryOSApp,
  check: (value: unknown) => T,
): Promise<T | null> {
  const file = await openTextFile(app, { accept: [".json"], maxBytes: 16 * 1024 * 1024 });
  if (!file) return null;
  return check(JSON.parse(file.text) as unknown);
}

/** A person-readable message for an error from EveryOS, the network or the app itself. */
export function errorMessage(t: Translate, error: unknown): string {
  if (isBridgeError(error)) {
    if (error.code === "EVERYOS_PERMISSION_DENIED") {
      const capability = (error.details as { capability?: string } | null)?.capability ?? "";
      return t("ui.permissionMissing", { action: capability });
    }
    if (error.code === "EVERYOS_CANCELLED") return "";
    if (error.message) return error.message;
  }
  if (error instanceof RangeError && error.message.startsWith("too-large:"))
    return t("ui.fileTooLarge", { max: formatBytes(Number(error.message.slice(10))) });
  if (error instanceof SyntaxError) return t("ui.importFailed");
  return t("ui.errorText");
}

export function formatBytes(bytes: number, locale?: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit && value < 10 ? 1 : 0 }).format(value)} ${units[unit]}`;
}
