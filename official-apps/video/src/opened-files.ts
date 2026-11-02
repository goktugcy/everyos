import type { FileHandle } from "@everyos/app-sdk";

export function openedFiles(
  value: unknown,
): { requestId: string; files: FileHandle[]; error: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const data = value as { type?: unknown; requestId?: unknown; files?: unknown; error?: unknown };
  if (
    data.type !== "everyos.file-open" ||
    typeof data.requestId !== "string" ||
    !/^[\w-]{1,128}$/.test(data.requestId)
  )
    return null;
  const files: FileHandle[] = [];
  for (const raw of (Array.isArray(data.files) ? data.files : []).slice(0, 100)) {
    if (!raw || typeof raw !== "object") continue;
    const file = raw as Partial<FileHandle>;
    if (
      file.kind !== "file" ||
      typeof file.id !== "string" ||
      !/^[\w-]{1,128}$/.test(file.id) ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 255
    )
      continue;
    files.push({
      id: file.id,
      name: file.name,
      kind: "file",
      size:
        typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0
          ? file.size
          : null,
      type: typeof file.type === "string" ? file.type : null,
      writable: file.writable === true,
      persistent: file.persistent === true,
    });
  }
  return {
    requestId: data.requestId,
    files,
    error: typeof data.error === "string" ? data.error : null,
  };
}
