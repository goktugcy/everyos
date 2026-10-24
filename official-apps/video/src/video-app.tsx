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
  useApp,
  useAsync,
  useI18n,
  usePersistentState,
  useShortcuts,
  useT,
} from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import {
  CODECS,
  VIDEO_TYPES,
  captions,
  cleanName,
  isVideo,
  mimeOfVideo,
  playlistId,
  resumePosition,
  videoPreferences,
  type VideoPreferences,
} from "./video.ts";

export function VideoApp() {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [raw, setRaw, stored] = usePersistentState<unknown>("video.v1", null);
  const prefs = videoPreferences(raw);
  const latest = useRef(prefs);
  latest.current = prefs;
  const [allowed, setAllowed] = useState(app.permissions.has("files:pick"));
  const [visible, setVisible] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const media = useRef<HTMLVideoElement>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const restoring = useRef(true);
  const resume = useRef<{ id: string; seconds: number; playing: boolean } | null>(null);
  const lastSave = useRef(0);
  const list = prefs.lists.find((item) => item.id === prefs.list)!;
  const shares = useAsync(
    async () => (allowed ? await app.files.handles() : []),
    [app, allowed, epoch],
  );
  const files =
    allowed && !shares.loading
      ? list.ids.flatMap(
          (id) =>
            shares.data?.find(
              (file) => file.id === id && file.kind === "file" && isVideo(file.name),
            ) ?? [],
        )
      : [];
  const file = files.find((item) => item.id === prefs.current) ?? files[0] ?? null;
  const source = useAsync(
    async () =>
      file && allowed && visible ? { id: file.id, epoch, src: await app.files.url(file) } : null,
    [app, file?.id, allowed, visible, epoch],
  );
  const src =
    source.data?.id === file?.id && source.data?.epoch === epoch ? source.data.src : undefined;
  const subtitle = file
    ? (shares.data?.find((item) => item.id === prefs.subtitles[file.id] && item.kind === "file") ??
      null)
    : null;
  const reader = useRef<AbortController | null>(null);
  const track = useAsync(async () => {
    reader.current?.abort();
    const request = new AbortController();
    reader.current = request;
    if (!subtitle || !file || !allowed || !visible) return null;
    return {
      file: file.id,
      subtitle: subtitle.id,
      epoch,
      cues: captions(
        new TextDecoder().decode(
          await app.files.read(subtitle, { signal: request.signal, maxBytes: 1024 * 1024 }),
        ),
      ),
    };
  }, [app, file?.id, subtitle?.id, allowed, visible, epoch]);
  const change = (patch: Partial<VideoPreferences>) =>
    setRaw((raw: unknown) => videoPreferences({ ...videoPreferences(raw), ...patch }));
  const remember = (force = false, ended = false) => {
    const node = media.current;
    if (!node || !file || restoring.current || !Number.isFinite(node.currentTime)) return;
    if (!force && Date.now() - lastSave.current < 3000) return;
    lastSave.current = Date.now();
    const seconds = ended ? 0 : Math.max(0, Math.min(604800, node.currentTime));
    setRaw((raw: unknown) => {
      const state = videoPreferences(raw);
      return videoPreferences({
        ...state,
        positions: { ...state.positions, [file.id]: { seconds, at: Date.now() } },
      });
    });
  };
  const refresh = () => {
    const node = media.current;
    if (node && file)
      resume.current = { id: file.id, seconds: node.currentTime, playing: !node.paused };
    remember(true);
    restoring.current = true;
    setPlaybackError(false);
    setEpoch((n) => n + 1);
  };
  useEffect(() => {
    const stop = () => {
      remember(true);
      resume.current = null;
      restoring.current = true;
      media.current?.pause();
      reader.current?.abort();
      generation.current++;
      active.current = false;
      setBusy(false);
      setPlaying(false);
    };
    const permissions = app.permissions.onChange(() => {
      stop();
      setAllowed(app.permissions.has("files:pick"));
      setEpoch((n) => n + 1);
    });
    const revoked = app.files.onRevoked(() => {
      stop();
      setEpoch((n) => n + 1);
    });
    const suspend = app.lifecycle.onSuspend(() => {
      stop();
      setVisible(false);
    });
    const resumed = app.lifecycle.onResume(() => {
      setVisible(true);
      setEpoch((n) => n + 1);
    });
    const pagehide = () => {
      stop();
      void stored.flush();
    };
    window.addEventListener("pagehide", pagehide);
    return () => {
      permissions();
      revoked();
      suspend();
      resumed();
      window.removeEventListener("pagehide", pagehide);
      reader.current?.abort();
      generation.current++;
    };
  }, [app, file?.id, stored.flush]);
  useEffect(() => {
    if (!visible || !file) return;
    const timer = setInterval(refresh, 9 * 60 * 1000);
    return () => clearInterval(timer);
  }, [file?.id, visible]);
  useEffect(() => {
    restoring.current = true;
    setPlaybackError(false);
    setPlaying(false);
  }, [file?.id]);
  useEffect(() => {
    if (media.current) media.current.playbackRate = prefs.rate;
  }, [prefs.rate]);
  useEffect(() => {
    const node = media.current;
    const data = track.data;
    if (
      !node ||
      !data ||
      data.file !== file?.id ||
      data.subtitle !== subtitle?.id ||
      data.epoch !== epoch
    )
      return;
    const text =
      node.textTracks[0] ?? node.addTextTrack("subtitles", t("video.subtitles"), i18n.locale);
    if (text.cues) [...text.cues].forEach((cue) => text.removeCue(cue));
    data.cues.forEach((cue) => text.addCue(new VTTCue(cue.start, cue.end, cue.text)));
    text.mode = latest.current.captions ? "showing" : "disabled";
    return () => {
      text.mode = "disabled";
      if (text.cues) [...text.cues].forEach((cue) => text.removeCue(cue));
    };
  }, [track.data, file?.id, subtitle?.id, epoch, i18n.locale]);
  useEffect(() => {
    const text = media.current?.textTracks[0];
    if (text) text.mode = prefs.captions ? "showing" : "disabled";
  }, [prefs.captions]);
  const perform = async (work: (current: number) => Promise<void>) => {
    if (active.current || !stored.loaded || !app.permissions.has("files:pick")) return;
    const current = generation.current;
    active.current = true;
    setBusy(true);
    setError(null);
    try {
      await work(current);
    } catch (cause) {
      if (current === generation.current && errorMessage(t, cause)) setError(cause);
    } finally {
      if (current === generation.current) {
        active.current = false;
        setBusy(false);
      }
    }
  };
  const add = () =>
    void perform(async (current) => {
      const selected = (
        await app.files.open({ accept: VIDEO_TYPES, multiple: true, persist: true })
      ).filter((item) => item.kind === "file" && isVideo(item.name));
      if (current !== generation.current || !selected.length) return;
      setRaw((raw: unknown) => {
        const state = videoPreferences(raw);
        return videoPreferences({
          ...state,
          lists: state.lists.map((item) =>
            item.id === state.list
              ? {
                  ...item,
                  ids: [...new Set([...item.ids, ...selected.map((file) => file.id)])].slice(
                    0,
                    100,
                  ),
                }
              : item,
          ),
        });
      });
      refresh();
    });
  const select = (id: string, continuePlaying?: boolean) => {
    const node = media.current;
    resume.current = {
      id,
      seconds: latest.current.positions[id]?.seconds ?? 0,
      playing: continuePlaying ?? (node ? !node.paused : false),
    };
    remember(true);
    restoring.current = true;
    node?.pause();
    change({ current: id });
  };
  const next = (offset: number, continuePlaying?: boolean) => {
    if (files.length)
      select(
        files[
          (files.findIndex((item) => item.id === file?.id) + offset + files.length) % files.length
        ]!.id,
        continuePlaying,
      );
  };
  const subtitleFile = () =>
    void perform(async (current) => {
      if (!file) return;
      const [selected] = await app.files.open({ accept: [".vtt", ".srt"], persist: true });
      if (selected && current === generation.current) {
        setRaw((raw: unknown) => {
          const state = videoPreferences(raw);
          return videoPreferences({
            ...state,
            subtitles: { ...state.subtitles, [file.id]: selected.id },
            captions: true,
          });
        });
        refresh();
      }
    });
  const rename = (creating: boolean) =>
    void perform(async (current) => {
      const name = await app.dialogs.prompt(
        t(creating ? "video.newList" : "video.renameList"),
        "",
        { value: creating ? "" : list.name || t("video.defaultList") },
      );
      if (name === null || !cleanName(name) || current !== generation.current) return;
      if (creating) {
        remember(true);
        restoring.current = true;
        media.current?.pause();
        const id = playlistId();
        change({
          lists: [...prefs.lists, { id, name: cleanName(name), ids: [] }],
          list: id,
          current: null,
        });
      } else
        change({
          lists: prefs.lists.map((item) =>
            item.id === list.id ? { ...item, name: cleanName(name) } : item,
          ),
        });
    });
  const removeList = () =>
    void perform(async (current) => {
      if (
        (await app.dialogs.confirm(t("video.deleteList"), t("video.referencesOnly"), {
          destructive: true,
        })) &&
        current === generation.current
      ) {
        remember(true);
        restoring.current = true;
        media.current?.pause();
        change({ lists: prefs.lists.filter((item) => item.id !== list.id), current: null });
      }
    });
  const toggle = () => {
    const node = media.current;
    if (!node) return;
    if (node.paused) void node.play().catch((cause: unknown) => setError(cause));
    else node.pause();
  };
  const fullscreen = () => {
    if (media.current)
      void media.current.requestFullscreen().catch(() => setError(new Error("fullscreen")));
  };
  useShortcuts({
    "mod+o": add,
    escape: () => {
      if (document.fullscreenElement)
        void document.exitFullscreen().catch(() => setError(new Error("fullscreen")));
    },
  });
  const problem = (cause: unknown) =>
    cause instanceof Error &&
    (cause.message === "subtitle-limit" || cause.message === "invalid-subtitles")
      ? t("video.badSubtitles")
      : cause instanceof Error && cause.message === "fullscreen"
        ? t("video.fullscreenError")
        : errorMessage(t, cause);
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button
            disabled={busy || !allowed || !stored.loaded || list.ids.length >= 100}
            onClick={add}
          >
            {t("video.add")}
          </Button>
          <Button disabled={busy || !file || !allowed} onClick={subtitleFile}>
            {t("video.openSubtitles")}
          </Button>
          <Button disabled={!file || !src || !document.fullscreenEnabled} onClick={fullscreen}>
            {t("video.fullscreen")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="video-main">
        <p className="video-hint">{t("video.scope")}</p>
        {!allowed ? <p role="status">{t("video.permission")}</p> : null}
        {!stored.loaded || shares.loading || source.loading || track.loading ? (
          <LoadingState />
        ) : null}
        {[stored.error, shares.error, source.error, track.error, error]
          .filter(Boolean)
          .map((cause, index) => (
            <p role="alert" key={index}>
              {problem(cause)}
            </p>
          ))}
        <div className="video-tools">
          <Select
            label={t("video.playlist")}
            value={list.id}
            options={prefs.lists.map((item) => ({
              value: item.id,
              label: item.name || t("video.defaultList"),
            }))}
            disabled={busy}
            onChange={(id) => {
              remember(true);
              restoring.current = true;
              media.current?.pause();
              change({ list: id, current: null });
            }}
          />
          <Button
            disabled={busy || !allowed || prefs.lists.length >= 20}
            onClick={() => rename(true)}
          >
            {t("video.newList")}
          </Button>
          <Button disabled={busy || !allowed} onClick={() => rename(false)}>
            {t("video.renameList")}
          </Button>
          <Button disabled={busy || !allowed} onClick={removeList}>
            {t("video.deleteList")}
          </Button>
        </div>
        {!shares.loading && list.ids.length > files.length ? (
          <p role="status">{t("video.revoked")}</p>
        ) : null}
        {!file ? (
          <EmptyState title={t("video.empty")} text={t("video.openHint")} />
        ) : (
          <>
            <div className="video-tools">
              <Select
                label={t("video.selected")}
                value={file.id}
                options={files.map((item) => ({ value: item.id, label: item.name }))}
                onChange={select}
              />
              <Button disabled={files.length < 2} onClick={() => next(-1)}>
                {t("video.previous")}
              </Button>
              <Button disabled={files.length < 2} onClick={() => next(1)}>
                {t("video.next")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  remember(true);
                  restoring.current = true;
                  media.current?.pause();
                  change({
                    lists: prefs.lists.map((item) =>
                      item.id === list.id
                        ? { ...item, ids: item.ids.filter((id) => id !== file.id) }
                        : item,
                    ),
                    current: null,
                  });
                }}
              >
                {t("video.remove")}
              </Button>
            </div>
            <video
              ref={media}
              key={file.id}
              src={src}
              controls
              playsInline
              preload="metadata"
              aria-label={t("video.player")}
              onLoadedMetadata={(event) => {
                const node = event.currentTarget;
                if (!src || node !== media.current) return;
                const state = latest.current;
                const previous = resume.current?.id === file.id ? resume.current : null;
                const position = previous?.seconds ?? state.positions[file.id]?.seconds ?? 0;
                node.playbackRate = state.rate;
                node.volume = state.volume;
                node.muted = state.muted;
                node.currentTime = resumePosition(position, node.duration);
                restoring.current = false;
                setPlaybackError(false);
                if (previous?.playing) void node.play().catch((cause: unknown) => setError(cause));
                resume.current = null;
              }}
              onTimeUpdate={() => remember()}
              onSeeked={() => remember(true)}
              onPause={() => {
                setPlaying(false);
                remember(true);
              }}
              onPlay={() => setPlaying(true)}
              onEnded={() => {
                remember(true, true);
                if (files.findIndex((item) => item.id === file.id) < files.length - 1) {
                  restoring.current = true;
                  next(1, true);
                } else setPlaying(false);
              }}
              onVolumeChange={(event) => {
                if (!restoring.current)
                  change({ volume: event.currentTarget.volume, muted: event.currentTarget.muted });
              }}
              onRateChange={(event) => {
                if (!restoring.current) change({ rate: event.currentTarget.playbackRate });
              }}
              onError={() => {
                if (src) {
                  setPlaybackError(true);
                  setPlaying(false);
                }
              }}
            />
            {playbackError ? <p role="alert">{t("video.unsupported")}</p> : null}
            <div className="video-tools">
              <Button disabled={!src || playbackError} onClick={toggle}>
                {t(playing ? "video.pause" : "video.play")}
              </Button>
              <Button onClick={refresh}>{t("video.reload")}</Button>
              <Select
                label={t("video.speed")}
                value={String(prefs.rate)}
                options={[...new Set([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, prefs.rate])]
                  .toSorted((a, b) => a - b)
                  .map((rate) => ({ value: String(rate), label: `${i18n.number(rate)}×` }))}
                onChange={(value) => change({ rate: Number(value) })}
              />
              {subtitle ? (
                <>
                  <span>{subtitle.name}</span>
                  <Button
                    aria-pressed={prefs.captions}
                    onClick={() => change({ captions: !prefs.captions })}
                  >
                    {t(prefs.captions ? "video.hideSubtitles" : "video.showSubtitles")}
                  </Button>
                </>
              ) : null}
            </div>
            <p className="video-hint">{t("video.captionHint")}</p>
            <details className="video-codecs">
              <summary>{t("video.codecs")}</summary>
              <p className="video-hint">{t("video.codecHint")}</p>
              <dl>
                {[mimeOfVideo(file.name), ...CODECS].map((mime) => {
                  const supported = document.createElement("video").canPlayType(mime);
                  return (
                    <div key={mime}>
                      <dt>{mime}</dt>
                      <dd>
                        {t(
                          supported === "probably"
                            ? "video.probably"
                            : supported === "maybe"
                              ? "video.maybe"
                              : "video.notReported",
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          </>
        )}
      </div>
    </Shell>
  );
}
