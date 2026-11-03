import type { FileHandle } from "@everyos/app-sdk";
import { errorMessage, useApp, useT, useToast } from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import {
  blankWorkbook,
  MAX_OFFICE_BYTES,
  OfficeError,
  type OfficeFormat,
  wordDocument,
} from "./container.ts";
import { officeHandoff } from "./handoff.ts";
import { prepareOfficeFile, prepareCsvSave } from "./prepare.ts";
import type { CsvSettings } from "./csv-format.ts";

export interface OfficeDocument {
  id: string;
  bytes: Uint8Array;
  name: string;
  handle: FileHandle | null;
  legacy: boolean;
  csv: CsvSettings | null;
  dirty: boolean;
  revision: number;
}

export function useOffice(format: OfficeFormat) {
  const app = useApp();
  const t = useT();
  const toast = useToast();
  const [document, setDocument] = useState<OfficeDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<OfficeDocument | null>(null);
  const exporter = useRef<(() => Promise<Uint8Array>) | null>(null);
  const operations = useRef<Promise<void>>(Promise.resolve());
  const callbacks = useRef({ t, toast });
  const initialized = useRef(false);
  const inFlight = useRef(false);
  const closing = useRef(false);
  const handled = useRef(new Set<string>());
  const active = useRef<AbortController | null>(null);
  const [handoff, setHandoff] = useState(app.window.initialState);
  const accept = format === "docx" ? [".docx", ".doc"] : [".xlsx", ".xls", ".csv"];
  useEffect(() => {
    callbacks.current = { t, toast };
  }, [t, toast]);
  const update = (value: OfficeDocument | null) => {
    current.current = value;
    setDocument(value);
  };
  const report = (cause: unknown) => {
    const message =
      cause instanceof OfficeError
        ? callbacks.current.t(`office.errors.${cause.code}`)
        : errorMessage(callbacks.current.t, cause);
    setError(message);
    callbacks.current.toast(message, "danger");
  };
  const enqueue = (run: () => Promise<void>) => {
    const pending = operations.current.then(async () => {
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        await run();
      } catch (cause) {
        if (!active.current?.signal.aborted) report(cause);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    });
    operations.current = pending.catch(() => undefined);
    return pending;
  };
  const mayReplace = () =>
    !current.current?.dirty
      ? Promise.resolve(true)
      : app.dialogs.confirm(
          callbacks.current.t("office.discardTitle"),
          callbacks.current.t("office.discardBody"),
          { confirm: callbacks.current.t("office.discard"), destructive: true },
        );
  const install = (
    bytes: Uint8Array,
    name: string,
    handle: FileHandle | null,
    legacy: boolean,
    csv: CsvSettings | null = null,
  ) => {
    exporter.current = null;
    setReady(false);
    const id = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    update({
      id,
      bytes,
      name,
      handle,
      legacy,
      csv,
      dirty: false,
      revision: 0,
    });
  };
  const fresh = () =>
    enqueue(async () => {
      if (!(await mayReplace())) return;
      const bytes =
        format === "docx"
          ? await wordDocument()
          : await blankWorkbook(callbacks.current.t("office.sheetName"));
      install(bytes, `${callbacks.current.t("office.untitled")}.${format}`, null, false);
    });
  const load = async (handle: FileHandle) => {
    if (!accept.some((ext) => handle.name.toLowerCase().endsWith(ext)))
      throw new OfficeError("invalid");
    if (handle.size !== null && handle.size > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
    if (!(await mayReplace())) return;
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    const bytes = new Uint8Array(await app.files.read(handle));
    if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
    const labels = Object.fromEntries(
      [
        "headers",
        "footnotes",
        "endnotes",
        "annotations",
        "textboxes",
        "headerTextboxes",
        "image",
      ].map((key) => [key, callbacks.current.t(`office.legacyLabels.${key}`)]),
    );
    labels.sheetName = callbacks.current.t("office.sheetName");
    const prepared = await prepareOfficeFile(format, handle.name, bytes, labels, controller.signal);
    controller.signal.throwIfAborted();
    install(prepared.bytes, handle.name, handle, prepared.legacy, prepared.csv);
  };
  const open = () =>
    enqueue(async () => {
      const [handle] = await app.files.open({ accept, write: true, persist: true });
      if (handle) await load(handle);
    });
  const save = (asCopy = false) =>
    enqueue(async () => {
      const doc = current.current;
      const exportBytes = exporter.current;
      if (!doc || !exportBytes) return;
      const revision = doc.revision;
      let bytes = await exportBytes();
      if (bytes.length > MAX_OFFICE_BYTES) throw new OfficeError("tooLarge");
      let handle = !asCopy && !doc.legacy && doc.handle?.writable ? doc.handle : null;
      if (!handle) {
        const suggestedName = doc.legacy
          ? doc.name.replace(/\.(doc|xls)$/i, "." + format)
          : doc.name;
        handle = await app.files.save({
          suggestedName,
          accept: doc.csv ? [".csv", ".xlsx"] : ["." + format],
          persist: true,
        });
        if (!handle) return;
      }
      const csvTarget = doc.csv && handle.name.toLowerCase().endsWith(".csv");
      if (csvTarget) {
        const converted = await prepareCsvSave(bytes, doc.csv!);
        if (
          converted.sheets > 1 &&
          !(await app.dialogs.confirm(
            callbacks.current.t("office.csvSheetsTitle"),
            callbacks.current.t("office.csvSheetsBody"),
            { confirm: callbacks.current.t("office.save") },
          ))
        )
          return;
        bytes = converted.bytes;
      } else if (!handle.name.toLowerCase().endsWith("." + format))
        throw new OfficeError("invalid");
      // The SDK checks grants and optimistic revisions; a failed write never clears dirty state.
      await app.files.write(handle, bytes);
      const updated = (await app.files.handles()).find((entry) => entry.id === handle.id) ?? handle;
      const latest = current.current;
      if (latest?.id === doc.id)
        update({
          ...latest,
          handle: updated,
          name: updated.name,
          legacy: false,
          csv: csvTarget ? doc.csv : null,
          dirty: latest.revision !== revision,
        });
      callbacks.current.toast(callbacks.current.t("office.saved", { name: updated.name }));
    });
  const change = () => {
    const doc = current.current;
    if (doc) update({ ...doc, dirty: true, revision: doc.revision + 1 });
  };
  useEffect(() => app.window.onOpened(setHandoff), [app]);
  useEffect(() => {
    const request = officeHandoff(handoff);
    if (!request || handled.current.has(request.id)) return;
    handled.current.add(request.id);
    initialized.current = true;
    void enqueue(async () => {
      if (request.error) throw new OfficeError("invalid");
      const handle = request.files.find((entry) =>
        accept.some((ext) => entry.name.toLowerCase().endsWith(ext)),
      );
      if (!handle) throw new OfficeError("invalid");
      await load(handle);
    });
  });
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void fresh();
  });
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    void app.lifecycle
      .guardClose(() => {
        if (inFlight.current || closing.current) return false;
        if (!current.current?.dirty) return true;
        closing.current = true;
        // Decline immediately: a human confirmation must outlive the host's RPC deadline.
        void mayReplace()
          .then(async (confirmed) => {
            if (confirmed) await app.window.close();
          })
          .catch(report)
          .finally(() => {
            closing.current = false;
          });
        return false;
      })
      .catch(report);
  }, [app]);
  const titleName = document?.name;
  const titleDirty = document?.dirty;
  useEffect(() => {
    if (titleName) void app.window.setTitle(`${titleDirty ? "• " : ""}${titleName}`);
  }, [app, titleName, titleDirty]);
  const actions = useRef({ save, open });
  useEffect(() => {
    actions.current = { save, open };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (
        event.defaultPrevented ||
        !mod ||
        event.altKey ||
        (key !== "s" && (key !== "o" || event.shiftKey))
      )
        return;
      event.preventDefault();
      // Own host file shortcuts before the engine can also save or open a local browser file.
      event.stopImmediatePropagation();
      if (key === "s") void actions.current.save(event.shiftKey);
      else void actions.current.open();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return { document, busy, ready, error, exporter, setReady, fresh, open, save, change, report };
}
