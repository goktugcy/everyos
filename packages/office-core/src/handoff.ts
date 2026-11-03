import type { FileHandle } from "@everyos/app-sdk";

/** A file handoff carries only opaque SDK grants; a path never grants file access. */
export function officeHandoff(
  value: unknown,
): { id: string; files: FileHandle[]; error: string | null } | null {
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
    const handle = raw as Partial<FileHandle>;
    if (
      handle.kind !== "file" ||
      typeof handle.id !== "string" ||
      !/^[\w-]{1,128}$/.test(handle.id) ||
      typeof handle.name !== "string" ||
      !handle.name ||
      handle.name.length > 255
    )
      continue;
    files.push({
      id: handle.id,
      kind: "file",
      name: handle.name,
      size:
        typeof handle.size === "number" && Number.isSafeInteger(handle.size) && handle.size >= 0
          ? handle.size
          : null,
      type: typeof handle.type === "string" ? handle.type : "application/octet-stream",
      writable: handle.writable === true,
      persistent: handle.persistent === true,
    });
  }
  return { id: data.requestId, files, error: typeof data.error === "string" ? data.error : null };
}
