import { Button, useI18n, useT } from "@everyos/app-ui";
import { useEffect, useRef, useState } from "react";
import { rotated, zoomed } from "./images.ts";

/** Shared by the viewer and Gallery; the original image remains unchanged. */
export function ImageStage({
  src,
  name,
  onDimensions,
}: {
  src: string;
  name: string;
  onDimensions?: (width: number, height: number) => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ width: 600, height: 400 });
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const reset = () => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
  };
  useEffect(() => {
    reset();
    setNatural({ width: 0, height: 0 });
    setFailed(false);
  }, [src]);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const resize = () => {
      if (element.clientWidth && element.clientHeight)
        setSize({ width: element.clientWidth, height: element.clientHeight });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const turned = rotation % 180 !== 0;
  const fit = natural.width
    ? Math.min(
        1,
        size.width / (turned ? natural.height : natural.width),
        size.height / (turned ? natural.width : natural.height),
      )
    : 1;
  const move = (x: number, y: number) =>
    setPan((current) => ({
      x: Math.max(-10000, Math.min(10000, current.x + x)),
      y: Math.max(-10000, Math.min(10000, current.y + y)),
    }));
  return (
    <div className="image-stage">
      <div className="image-tools">
        <Button onClick={() => setZoom((n) => zoomed(n / 1.25))}>{t("image.zoomOut")}</Button>
        <span>{i18n.number(zoom, { style: "percent", maximumFractionDigits: 0 })}</span>
        <Button onClick={() => setZoom((n) => zoomed(n * 1.25))}>{t("image.zoomIn")}</Button>
        <Button onClick={() => setRotation((n) => rotated(n - 90))}>{t("image.rotateLeft")}</Button>
        <Button onClick={() => setRotation((n) => rotated(n + 90))}>
          {t("image.rotateRight")}
        </Button>
        <Button onClick={reset}>{t("image.fit")}</Button>
      </div>
      <div
        ref={box}
        className="image-canvas"
        tabIndex={0}
        role="region"
        aria-label={t("image.preview")}
        data-zoom={zoom}
        data-rotation={rotation}
        onDoubleClick={reset}
        onKeyDown={(event) => {
          if (!event.altKey) return;
          const steps: Record<string, [number, number]> = {
            ArrowLeft: [-30, 0],
            ArrowRight: [30, 0],
            ArrowUp: [0, -30],
            ArrowDown: [0, 30],
          };
          const step = steps[event.key];
          if (step) {
            event.preventDefault();
            move(...step);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          box.current?.setPointerCapture?.(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, startX: pan.x, startY: pan.y };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start)
            setPan({
              x: Math.max(-10000, Math.min(10000, start.startX + event.clientX - start.x)),
              y: Math.max(-10000, Math.min(10000, start.startY + event.clientY - start.y)),
            });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {failed ? (
          <p role="alert">{t("image.unsupported")}</p>
        ) : (
          <img
            src={src}
            alt={name}
            draggable={false}
            onError={() => setFailed(true)}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 80000000) {
                setFailed(true);
                return;
              }
              setNatural({ width: image.naturalWidth, height: image.naturalHeight });
              onDimensions?.(image.naturalWidth, image.naturalHeight);
            }}
            style={{
              width: natural.width || undefined,
              height: natural.height || undefined,
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${fit * zoom})`,
            }}
          />
        )}
      </div>
      <p className="image-hint">{t("image.panHint")}</p>
    </div>
  );
}
