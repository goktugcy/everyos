import type { FileHandle } from "@everyos/app-sdk";
import { useApp, useAsync } from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import { imageMetadata, MAX_IMAGE_BYTES } from "./images.ts";

/** Capability URLs are temporary and never stored. Reads are fenced on selection and revocation. */
export function useImage(file: FileHandle | null) {
  const app = useApp();
  const [revision, setRevision] = useState(0);
  const [awake, setAwake] = useState(true);
  const reader = useRef<AbortController | null>(null);
  useEffect(() => () => reader.current?.abort(), []);
  useEffect(() => {
    const resume = app.lifecycle.onResume(() => {
      setAwake(true);
      setRevision((n) => n + 1);
    });
    const suspend = app.lifecycle.onSuspend(() => {
      setAwake(false);
      reader.current?.abort();
    });
    const revoked = app.files.onRevoked(() => setRevision((n) => n + 1));
    return () => {
      resume();
      suspend();
      revoked();
    };
  }, [app]);
  useEffect(() => {
    if (!awake) return;
    const timer = setInterval(() => setRevision((n) => n + 1), 9 * 60 * 1000);
    return () => clearInterval(timer);
  }, [awake]);
  const resource = useAsync(async () => {
    reader.current?.abort();
    const request = new AbortController();
    reader.current = request;
    if (!file || !awake || !app.permissions.has("files:pick")) return null;
    if (file.size !== null && file.size > MAX_IMAGE_BYTES)
      throw new RangeError(`too-large:${MAX_IMAGE_BYTES}`);
    const src = await app.files.url(file);
    const bytes = await app.files.read(file, { signal: request.signal, maxBytes: MAX_IMAGE_BYTES });
    const metadata = await imageMetadata(bytes, file.name);
    return { id: file.id, src, metadata, revision, bytes: bytes.byteLength };
  }, [app, file?.id, revision]);
  return {
    ...resource,
    data:
      resource.data?.id === file?.id && resource.data?.revision === revision ? resource.data : null,
  };
}
