import type { FileHandle } from "@everyos/app-sdk";
import { Button, Checkbox, formatBytes, useApp, useI18n, useT } from "@everyos/app-ui";
import { useEffect, useState } from "react";
import { photoHandle, type Photo } from "./albums.ts";

/** Four bridge requests at a time, at most one visible 40-image page. URLs never persist. */
export function PhotoGrid({
  items,
  shares,
  epoch,
  selected,
  toggle,
  favorite,
  open,
  disabled,
}: {
  items: Photo[];
  shares: FileHandle[];
  epoch: number;
  selected: Set<string>;
  toggle: (key: string) => void;
  favorite: (key: string) => void;
  open: (photo: Photo, file: FileHandle) => void;
  disabled: boolean;
}) {
  const app = useApp();
  const t = useT();
  const i18n = useI18n();
  const [loaded, setLoaded] = useState<{
    epoch: number;
    entries: Map<string, { src: string; file: FileHandle } | null>;
  }>({ epoch, entries: new Map() });
  const key = items.map((item) => item.key).join("\0");
  const shareIds = shares.map((item) => item.id).join(",");
  useEffect(() => {
    let live = true;
    let cursor = 0;
    setLoaded({ epoch, entries: new Map() });
    const worker = async () => {
      while (live && cursor < items.length) {
        const photo = items[cursor++]!;
        let value: { src: string; file: FileHandle } | null = null;
        try {
          const file = await photoHandle(app.files, photo, shares);
          if (file) value = { file, src: await app.files.url(file) };
        } catch {
          /* An unavailable share is shown per image. */
        }
        if (live)
          setLoaded((current) => ({
            epoch,
            entries: new Map(current.entries).set(photo.key, value),
          }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
    return () => {
      live = false;
    };
  }, [app, key, shareIds, epoch]);
  return (
    <div className="gallery-grid">
      {items.map((photo) => {
        const image = loaded.epoch === epoch ? loaded.entries.get(photo.key) : undefined;
        return (
          <article className="gallery-photo" key={photo.key}>
            <Button
              className="gallery-thumbnail"
              disabled={!image || disabled}
              aria-label={t("gallery.previewNamed", { name: photo.name })}
              onClick={() => {
                if (image) open(photo, image.file);
              }}
            >
              {image ? (
                <img
                  src={image.src}
                  alt={photo.name}
                  loading="lazy"
                  onError={() =>
                    setLoaded((current) => ({
                      ...current,
                      entries: new Map(current.entries).set(photo.key, null),
                    }))
                  }
                />
              ) : (
                <span>{t(image === null ? "gallery.unavailable" : "gallery.loading")}</span>
              )}
            </Button>
            <p>{photo.name}</p>
            <span className="image-hint">{formatBytes(photo.size, i18n.locale)}</span>
            <Checkbox
              label={t("gallery.selectNamed", { name: photo.name })}
              checked={selected.has(photo.key)}
              onChange={() => toggle(photo.key)}
            />
            <Button
              disabled={disabled}
              aria-pressed={photo.favorite}
              onClick={() => favorite(photo.key)}
            >
              {t(photo.favorite ? "gallery.unfavorite" : "gallery.favorite")}
            </Button>
          </article>
        );
      })}
    </div>
  );
}
