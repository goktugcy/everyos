import type { FileHandle } from "@everyos/app-sdk";
import { errorMessage, LoadingState, useApp, useAsync, useT } from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import { resumePosition } from "../../video/src/video.ts";

/** Stream an approved video; neither its bytes nor its temporary URL enter album storage. */
export function GalleryVideo({
  file,
  epoch,
  slideshow,
  onEnded,
}: {
  file: FileHandle;
  epoch: number;
  slideshow: boolean;
  onEnded: () => void;
}) {
  const app = useApp();
  const t = useT();
  const media = useRef<HTMLVideoElement>(null);
  const resume = useRef<{ seconds: number; playing: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const source = useAsync(async () => {
    const node = media.current;
    if (node?.currentSrc) resume.current = { seconds: node.currentTime, playing: !node.paused };
    setFailed(false);
    return app.files.url(file);
  }, [app, file.id, epoch]);
  useEffect(() => {
    const node = media.current;
    return () => {
      node?.pause();
      node?.removeAttribute("src");
      node?.load();
    };
  }, []);
  return (
    <>
      {source.loading ? <LoadingState /> : null}
      {source.error ? <p role="alert">{errorMessage(t, source.error)}</p> : null}
      <video
        ref={media}
        src={source.data ?? undefined}
        controls
        playsInline
        autoPlay={slideshow}
        preload="metadata"
        aria-label={t("gallery.previewNamed", { name: file.name })}
        onLoadedMetadata={(event) => {
          const node = event.currentTarget;
          if (resume.current) {
            node.currentTime = resumePosition(resume.current.seconds, node.duration);
            if (resume.current.playing) void node.play().catch(() => undefined);
            resume.current = null;
          }
          setFailed(false);
        }}
        onEnded={onEnded}
        onError={() => {
          if (source.data) setFailed(true);
        }}
      />
      {failed ? <p role="alert">{t("video.unsupported")}</p> : null}
    </>
  );
}
