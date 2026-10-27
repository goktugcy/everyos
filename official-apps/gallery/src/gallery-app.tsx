import type { FileHandle } from "@everyos/app-sdk";
import {
  Button,
  Checkbox,
  EmptyState,
  LoadingState,
  SearchInput,
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
import { IMAGE_TYPES } from "../../images/src/images.ts";
import { ImageStage } from "../../images/src/image-stage.tsx";
import { useImage } from "../../images/src/use-image.ts";
import {
  albumContent,
  albumName,
  emptyAlbum,
  galleryPreferences,
  manualPhoto,
  newId,
  photoHandle,
  photos,
  scanImages,
  type Album,
  type GalleryPreferences,
  type Photo,
} from "./albums.ts";
import { PhotoGrid } from "./photo-grid.tsx";

export function GalleryApp() {
  const app = useApp();
  const t = useT();
  const [raw, setRaw, stored] = usePersistentState<unknown>("gallery.v1", null);
  const prefs = galleryPreferences(raw);
  const [error, setError] = useState<unknown>(null);
  const [active, setActive] = useState(false);
  const flushAlbum = useRef<(() => Promise<void>) | null>(null);
  const album = prefs.albums.find((item) => item.id === prefs.current) ?? prefs.albums[0] ?? null;
  const change = (patch: Partial<GalleryPreferences>) => {
    if (!active) setRaw({ ...prefs, ...patch });
  };
  const rename = async (creating: boolean) => {
    if (active || !stored.loaded) return;
    setActive(true);
    setError(null);
    try {
      const answer = await app.dialogs.prompt(
        t(creating ? "gallery.create" : "gallery.rename"),
        "",
        { value: creating ? "" : (album?.name ?? "") },
      );
      if (answer === null || !albumName(answer)) return;
      if (creating) {
        const item = { id: newId(), name: albumName(answer) };
        setRaw({ ...prefs, albums: [...prefs.albums, item].slice(0, 20), current: item.id });
      } else if (album)
        setRaw({
          ...prefs,
          albums: prefs.albums.map((item) =>
            item.id === album.id ? { ...item, name: albumName(answer) } : item,
          ),
        });
    } catch (cause) {
      setError(cause);
    } finally {
      setActive(false);
    }
  };
  const remove = async () => {
    if (
      !album ||
      active ||
      !(await app.dialogs.confirm(t("gallery.delete"), t("gallery.deleteHint"), {
        destructive: true,
      }))
    )
      return;
    setActive(true);
    try {
      await flushAlbum.current?.();
      await app.storage.delete(`album/${album.id}`);
      const albums = prefs.albums.filter((item) => item.id !== album.id);
      setRaw({ ...prefs, albums, current: albums[0]?.id ?? null });
    } catch (cause) {
      setError(cause);
    } finally {
      setActive(false);
    }
  };
  return (
    <Shell
      toolbar={() => (
        <Toolbar>
          <ToolbarTitle>{t("app.name")}</ToolbarTitle>
          <Spacer />
          <Button
            disabled={active || !stored.loaded || prefs.albums.length >= 20}
            onClick={() => void rename(true)}
          >
            {t("gallery.create")}
          </Button>
          <Button disabled={active || !album} onClick={() => void rename(false)}>
            {t("gallery.rename")}
          </Button>
          <Button disabled={active || !album} onClick={() => void remove()}>
            {t("gallery.delete")}
          </Button>
        </Toolbar>
      )}
    >
      <div className="gallery-main">
        {stored.error || error ? (
          <p role="alert">{errorMessage(t, stored.error ?? error)}</p>
        ) : null}
        {!stored.loaded ? (
          <LoadingState />
        ) : (
          <>
            <Select
              label={t("gallery.album")}
              value={album?.id ?? ""}
              options={prefs.albums.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(id) => change({ current: id })}
            />
            {album ? (
              <AlbumPane
                key={album.id}
                album={album}
                prefs={prefs}
                change={change}
                locked={active}
                flush={flushAlbum}
              />
            ) : (
              <EmptyState title={t("gallery.empty")} text={t("gallery.emptyHint")} />
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

function AlbumPane({
  album,
  prefs,
  change,
  locked,
  flush,
}: {
  album: Album;
  prefs: GalleryPreferences;
  change: (patch: Partial<GalleryPreferences>) => void;
  locked: boolean;
  flush: { current: (() => Promise<void>) | null };
}) {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [raw, setRaw, stored] = usePersistentState<unknown>(`album/${album.id}`, emptyAlbum());
  const content = albumContent(raw);
  const [allowed, setAllowed] = useState(app.permissions.has("files:pick"));
  const [awake, setAwake] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const shares = useAsync(
    async () => (allowed && awake ? await app.files.handles() : []),
    [app, allowed, awake, epoch],
  );
  const available = allowed && awake && !shares.loading ? (shares.data ?? []) : [];
  const [working, setBusy] = useState(false);
  const busy = working || locked;
  const [error, setError] = useState<unknown>(null);
  const active = useRef(false);
  const generation = useRef(0);
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());
  const [opened, setOpened] = useState<{ photo: Photo; file: FileHandle } | null>(null);
  const [playing, setPlaying] = useState(false);
  const visible = photos(content, search, favorites, prefs.sort).filter((photo) =>
    available.some((share) => share.id === (photo.root ?? photo.file)),
  );
  const pages = Math.max(1, Math.ceil(visible.length / 40));
  const currentPage = Math.min(page, pages - 1);
  const pageItems = visible.slice(currentPage * 40, (currentPage + 1) * 40);
  const image = useImage(opened?.file ?? null);
  const update = (value: typeof content) => {
    if (!locked) setRaw(albumContent(value));
  };
  useEffect(() => {
    flush.current = stored.flush;
    return () => {
      flush.current = null;
    };
  }, [flush, stored.flush]);
  useEffect(() => {
    if (locked) {
      generation.current++;
      active.current = false;
      setBusy(false);
    }
  }, [locked]);
  useEffect(() => {
    const invalidate = () => {
      generation.current++;
      active.current = false;
      setBusy(false);
      setPlaying(false);
      setOpened(null);
      setEpoch((n) => n + 1);
    };
    const permissions = app.permissions.onChange(() => {
      setAllowed(app.permissions.has("files:pick"));
      invalidate();
    });
    const revoked = app.files.onRevoked(invalidate);
    const suspend = app.lifecycle.onSuspend(() => {
      invalidate();
      setAwake(false);
    });
    const resume = app.lifecycle.onResume(() => {
      setAwake(true);
      setEpoch((n) => n + 1);
    });
    return () => {
      permissions();
      revoked();
      suspend();
      resume();
      generation.current++;
    };
  }, [app]);
  useEffect(() => {
    if (!awake) return;
    const timer = setInterval(() => setEpoch((n) => n + 1), 9 * 60 * 1000);
    return () => clearInterval(timer);
  }, [awake]);
  const perform = async (work: (current: number) => Promise<void>) => {
    if (active.current || locked || !app.permissions.has("files:pick") || !stored.loaded) return;
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
        setEpoch((n) => n + 1);
      }
    }
  };
  const addFiles = () =>
    void perform(async (current) => {
      const files = await app.files.open({ accept: IMAGE_TYPES, multiple: true, persist: true });
      if (current !== generation.current) return;
      const items = files.flatMap((file) => manualPhoto(file) ?? []);
      update({
        ...content,
        items: [...content.items, ...items],
        partial: content.partial || items.length < files.length,
      });
    });
  const index = (pick: boolean) =>
    void perform(async (current) => {
      const chosen = pick
        ? await app.files.open({ directory: true, persist: true })
        : available.filter((file) => content.roots.some((root) => root.id === file.id));
      if (!chosen.length || current !== generation.current) return;
      let next = {
        ...content,
        partial: pick ? content.partial : chosen.length < content.roots.length,
      };
      for (const root of chosen.slice(0, 20)) {
        const scanned = await scanImages(app.files, root, {
          cancelled: () => current !== generation.current,
        });
        if (current !== generation.current) return;
        const favorites = new Set(
          next.items.filter((item) => item.favorite).map((item) => item.key),
        );
        next = albumContent({
          roots: [
            ...new Map(
              [...next.roots, { id: root.id, name: root.name }].map((item) => [item.id, item]),
            ).values(),
          ],
          items: [
            ...next.items.filter((item) => item.root !== root.id),
            ...scanned.items.map((item) => ({ ...item, favorite: favorites.has(item.key) })),
          ],
          indexedAt: Date.now(),
          partial: next.partial || scanned.partial,
        });
      }
      update(next);
    });
  const next = async (offset: number) => {
    if (!opened || !visible.length) return;
    const photo =
      visible[
        (visible.findIndex((item) => item.key === opened.photo.key) + offset + visible.length) %
          visible.length
      ]!;
    const current = generation.current;
    try {
      const file = await photoHandle(app.files, photo, available);
      if (file && current === generation.current) setOpened({ photo, file });
    } catch (cause) {
      setError(cause);
      setPlaying(false);
    }
  };
  useEffect(() => {
    if (!playing || !opened || visible.length < 2) return;
    const timer = setInterval(() => void next(1), prefs.interval);
    return () => clearInterval(timer);
  }, [playing, opened?.photo.key, visible.map((item) => item.key).join("\0"), prefs.interval]);
  useShortcuts({
    escape: () => {
      setOpened(null);
      setPlaying(false);
    },
    arrowleft: () => {
      if (opened) void next(-1);
    },
    arrowright: () => {
      if (opened) void next(1);
    },
  });
  const favorite = (key: string) =>
    update({
      ...content,
      items: content.items.map((item) =>
        item.key === key ? { ...item, favorite: !item.favorite } : item,
      ),
    });
  const removeSelected = async () => {
    if (
      await app.dialogs.confirm(t("gallery.removeSelected"), t("gallery.deleteHint"), {
        destructive: true,
      })
    ) {
      update({ ...content, items: content.items.filter((item) => !selected.has(item.key)) });
      setSelected(new Set());
      if (opened && selected.has(opened.photo.key)) {
        setOpened(null);
        setPlaying(false);
      }
    }
  };
  return (
    <section className="gallery-album">
      <p className="image-hint">{t("gallery.scope")}</p>
      {!allowed ? <p role="status">{t("image.permission")}</p> : null}
      {!stored.loaded || shares.loading || busy ? <LoadingState /> : null}
      {[stored.error, shares.error, error].filter(Boolean).map((cause, i) => (
        <p role="alert" key={i}>
          {errorMessage(t, cause)}
        </p>
      ))}
      <div className="image-tools">
        <Button disabled={busy || !allowed || !stored.loaded} onClick={addFiles}>
          {t("gallery.addFiles")}
        </Button>
        <Button
          disabled={busy || !allowed || !stored.loaded || content.roots.length >= 20}
          onClick={() => index(true)}
        >
          {t("gallery.addFolder")}
        </Button>
        <Button disabled={busy || !allowed || !content.roots.length} onClick={() => index(false)}>
          {t("gallery.refresh")}
        </Button>
      </div>
      {content.partial ? <p role="status">{t("gallery.partial")}</p> : null}
      {content.indexedAt ? (
        <p className="image-hint">
          {t("gallery.indexed", {
            at: i18n.date(content.indexedAt, { dateStyle: "medium", timeStyle: "short" }),
          })}
        </p>
      ) : null}
      {!shares.loading && visible.length < photos(content, search, favorites, prefs.sort).length ? (
        <p role="status">{t("image.revoked")}</p>
      ) : null}
      <div className="image-tools">
        <SearchInput
          label={t("gallery.search")}
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
        />
        <Select
          label={t("gallery.sort")}
          value={prefs.sort}
          options={[
            { value: "name", label: t("gallery.byName") },
            { value: "date", label: t("gallery.byDate") },
            { value: "size", label: t("gallery.bySize") },
          ]}
          onChange={(sort) => {
            change({ sort: sort });
            setPage(0);
          }}
        />
        <Checkbox
          label={t("gallery.favorites")}
          checked={favorites}
          onChange={(value) => {
            setFavorites(value);
            setPage(0);
          }}
        />
      </div>
      <div className="image-tools">
        <Button
          disabled={!pageItems.length}
          onClick={() => setSelected(new Set(pageItems.map((item) => item.key)))}
        >
          {t("gallery.selectPage")}
        </Button>
        <Button disabled={!selected.size} onClick={() => setSelected(new Set())}>
          {t("gallery.clearSelection")}
        </Button>
        <Button disabled={!selected.size || busy} onClick={() => void removeSelected()}>
          {t("gallery.removeSelected")}
        </Button>
        <span>
          {t("gallery.count", {
            count: i18n.number(visible.length),
            selected: i18n.number(selected.size),
          })}
        </span>
      </div>
      {opened ? (
        <section className="gallery-preview">
          <div className="image-tools">
            <Button
              onClick={() => {
                setOpened(null);
                setPlaying(false);
              }}
            >
              {t("gallery.closePreview")}
            </Button>
            <Button onClick={() => void next(-1)}>{t("image.previous")}</Button>
            <Button onClick={() => void next(1)}>{t("image.next")}</Button>
            <Button disabled={visible.length < 2} onClick={() => setPlaying((n) => !n)}>
              {t(playing ? "image.stop" : "image.slideshow")}
            </Button>
            <Select
              label={t("image.interval")}
              value={String(prefs.interval)}
              options={[2000, 5000, 10000, 30000].map((ms) => ({
                value: String(ms),
                label: t("image.seconds", { value: i18n.number(ms / 1000) }),
              }))}
              onChange={(value) => change({ interval: Number(value) })}
            />
          </div>
          <h2>{opened.photo.name}</h2>
          {image.error ? <p role="alert">{errorMessage(t, image.error)}</p> : null}
          {image.loading ? <LoadingState /> : null}
          {image.data ? <ImageStage src={image.data.src} name={opened.photo.name} /> : null}
        </section>
      ) : null}
      <PhotoGrid
        disabled={busy}
        items={pageItems}
        shares={available}
        epoch={epoch}
        selected={selected}
        toggle={(key) =>
          setSelected((items) => {
            const next = new Set(items);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
        favorite={favorite}
        open={(photo, file) => {
          setOpened({ photo, file });
          setPlaying(false);
        }}
      />
      {!visible.length && !shares.loading ? (
        <EmptyState title={t("gallery.noImages")} text={t("gallery.addHint")} />
      ) : null}
      <div className="image-tools">
        <Button disabled={currentPage === 0} onClick={() => setPage((n) => n - 1)}>
          {t("gallery.previousPage")}
        </Button>
        <span>
          {i18n.number(currentPage + 1)}/{i18n.number(pages)}
        </span>
        <Button disabled={currentPage >= pages - 1} onClick={() => setPage((n) => n + 1)}>
          {t("gallery.nextPage")}
        </Button>
      </div>
    </section>
  );
}
