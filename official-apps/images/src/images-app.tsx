import {
  Button,
  EmptyState,
  LoadingState,
  Select,
  Shell,
  Spacer,
  Toolbar,
  ToolbarTitle,
  errorMessage,
  formatBytes,
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useShortcuts,
  useT,
} from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import { ImageStage } from "./image-stage.tsx";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, imagePreferences, isImage } from "./images.ts";
import { useImage } from "./use-image.ts";

export function ImagesApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [raw, setRaw, stored] = usePersistentState<unknown>("images.v1", null);
  const prefs = imagePreferences(raw);
  const [allowed, setAllowed] = useState(app.permissions.has("files:pick"));
  const [saveAllowed, setSaveAllowed] = useState(app.permissions.has("files:save"));
  const [revision, setRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const handles = useAsync(
    async () => (allowed ? await app.files.handles() : []),
    [app, allowed, revision],
  );
  const files = allowed
    ? prefs.ids.flatMap((id) => handles.data?.find((file) => file.id === id && isImage(file)) ?? [])
    : [];
  const file = files.find((item) => item.id === prefs.current) ?? files[0] ?? null;
  const image = useImage(file);
  const choose = (offset: number) => {
    if (!files.length) return;
    const next =
      files[
        (files.findIndex((item) => item.id === file?.id) + offset + files.length) % files.length
      ]!;
    setRaw({ ...prefs, current: next.id });
  };
  useEffect(() => {
    setDimensions({ width: 0, height: 0 });
  }, [file?.id]);
  useEffect(() => {
    const invalidate = () => {
      generation.current++;
      active.current = false;
      setBusy(false);
      setPlaying(false);
    };
    const grants = app.permissions.onChange(() => {
      invalidate();
      setAllowed(app.permissions.has("files:pick"));
      setSaveAllowed(app.permissions.has("files:save"));
      setRevision((n) => n + 1);
    });
    const revoke = app.files.onRevoked(() => {
      invalidate();
      setRevision((n) => n + 1);
    });
    const suspend = app.lifecycle.onSuspend(invalidate);
    window.addEventListener("pagehide", invalidate);
    return () => {
      grants();
      revoke();
      suspend();
      window.removeEventListener("pagehide", invalidate);
      generation.current++;
    };
  }, [app]);
  useEffect(() => {
    if (!playing || files.length < 2) return;
    const timer = setInterval(() => choose(1), prefs.interval);
    return () => clearInterval(timer);
  }, [playing, files.map((item) => item.id).join(","), file?.id, prefs.interval]);
  const perform = async (work: (epoch: number) => Promise<void>) => {
    if (active.current || !app.permissions.has("files:pick")) return;
    const epoch = generation.current;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await work(epoch);
    } catch (cause) {
      if (epoch === generation.current && errorMessage(t, cause)) setError(cause);
    } finally {
      if (epoch === generation.current) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  const open = () =>
    void perform(async (epoch) => {
      const selected = (
        await app.files.open({ accept: IMAGE_TYPES, multiple: true, persist: true })
      ).filter(isImage);
      if (!selected.length || epoch !== generation.current) return;
      const ids = selected.slice(0, 100).map((item) => item.id);
      setRaw({ ...prefs, ids, current: ids[0] ?? null });
      setPlaying(false);
      setRevision((n) => n + 1);
    });
  const save = () => {
    if (!file) return;
    const selected = file;
    void perform(async (epoch) => {
      if (selected.size !== null && selected.size > MAX_IMAGE_BYTES)
        throw new RangeError(`too-large:${MAX_IMAGE_BYTES}`);
      const destination = await app.files.save({ suggestedName: selected.name });
      if (!destination || epoch !== generation.current || !app.permissions.has("files:save"))
        return;
      const bytes = await app.files.read(selected, { maxBytes: MAX_IMAGE_BYTES });
      if (epoch !== generation.current || !app.permissions.has("files:save")) return;
      await app.files.write(destination, bytes);
    });
  };
  useShortcuts({
    arrowleft: (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.closest("input,textarea,select,button")
      )
        choose(-1);
    },
    arrowright: (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.closest("input,textarea,select,button")
      )
        choose(1);
    },
    escape: () => setPlaying(false),
    "mod+o": open,
  });
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button disabled={busy || !allowed || !stored.loaded} onClick={open}>
            {t("image.open")}
          </Button>
          <Button disabled={busy || !file || !saveAllowed} onClick={save}>
            {t("image.save")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="images-main">
        <p className="image-hint">{t("image.scope")}</p>
        {!allowed ? <p role="status">{t("image.permission")}</p> : null}
        {!stored.loaded || handles.loading || image.loading ? <LoadingState /> : null}
        {[stored.error, handles.error, image.error, error].filter(Boolean).map((cause, index) => (
          <p role="alert" key={index}>
            {errorMessage(t, cause)}
          </p>
        ))}
        {prefs.ids.length && files.length < prefs.ids.length && !handles.loading ? (
          <p role="status">{t("image.revoked")}</p>
        ) : null}
        {!file ? (
          <EmptyState title={t("image.empty")} text={t("image.openHint")} />
        ) : (
          <>
            <div className="image-tools">
              <Button disabled={files.length < 2} onClick={() => choose(-1)}>
                {t("image.previous")}
              </Button>
              <Select
                label={t("image.selection")}
                value={file.id}
                options={files.map((item) => ({ value: item.id, label: item.name }))}
                onChange={(id) => {
                  setRaw({ ...prefs, current: id });
                  setPlaying(false);
                }}
              />
              <Button disabled={files.length < 2} onClick={() => choose(1)}>
                {t("image.next")}
              </Button>
              <Button disabled={files.length < 2} onClick={() => setPlaying((value) => !value)}>
                {t(playing ? "image.stop" : "image.slideshow")}
              </Button>
              <Select
                label={t("image.interval")}
                value={String(prefs.interval)}
                options={[2000, 5000, 10000, 30000].map((ms) => ({
                  value: String(ms),
                  label: t("image.seconds", { value: i18n.number(ms / 1000) }),
                }))}
                onChange={(value) => setRaw({ ...prefs, interval: Number(value) })}
              />
            </div>
            {image.data ? (
              <ImageStage
                key={file.id}
                src={image.data.src}
                name={file.name}
                onDimensions={(width, height) => setDimensions({ width, height })}
              />
            ) : null}
            <section className="image-metadata">
              <h2>{t("image.metadata")}</h2>
              <p>
                {file.name} ·{" "}
                {image.data
                  ? formatBytes(image.data.bytes, i18n.locale)
                  : file.size === null
                    ? ""
                    : formatBytes(file.size, i18n.locale)}{" "}
                · {file.type ?? ""}
              </p>
              {dimensions.width ? (
                <p>
                  {i18n.number(dimensions.width)} × {i18n.number(dimensions.height)} px
                </p>
              ) : null}
              {image.data?.metadata.failed ? <p>{t("image.metadataFailed")}</p> : null}
              <dl>
                {image.data?.metadata.tags.map((tag) => (
                  <div key={tag.key}>
                    <dt>{tag.key}</dt>
                    <dd>
                      {typeof tag.value === "number"
                        ? i18n.number(tag.value, { maximumFractionDigits: 7 })
                        : tag.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}
