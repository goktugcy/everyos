import type { FileEntry } from "@everyos/shared";
import {
  Archive,
  AlignLeft,
  BookOpen,
  Braces,
  CalendarDays,
  ChartNoAxesCombined,
  CodeXml,
  Database,
  File,
  FileQuestion,
  FileText,
  Film,
  HardDrive,
  Image,
  Link2,
  Music2,
  PenTool,
  Sheet,
  Type,
  type LucideIcon,
} from "lucide-react";
import { useId } from "react";
import { cn } from "../../../lib/cn.ts";
import { FileTypeArt } from "./file-type-art.tsx";

type FileIdentity = Pick<FileEntry, "name" | "type" | "link">;

const FORMATS = [
  ["text", "txt text md markdown mdown log ini conf cfg cnf env properties srt vtt", AlignLeft],
  ["pdf", "pdf", BookOpen],
  ["document", "doc docx odt rtf pages", FileText],
  ["spreadsheet", "xls xlsx xlsm xlsb ods csv tsv numbers", Sheet],
  ["presentation", "ppt pptx odp key", ChartNoAxesCombined],
  ["image", "png jpg jpeg gif webp avif bmp ico svg heic heif tif tiff raw", Image],
  ["video", "mp4 m4v webm ogv mov mkv avi mpeg mpg wmv flv", Film],
  ["audio", "mp3 flac ogg opus wav m4a aac aiff wma", Music2],
  ["archive", "zip tar gz tgz xz bz2 7z rar zst br", Archive],
  ["data", "json jsonc jsonl geojson ndjson", Braces],
  ["database", "db sqlite sqlite3 sql dump", Database],
  ["calendar", "ics ical ifb icalendar", CalendarDays],
  ["drawing", "excalidraw fig sketch ai eps psd", PenTool],
  ["font", "ttf otf woff woff2 eot", Type],
  ["disk", "iso img dmg vhd vhdx qcow2 vmdk", HardDrive],
  [
    "code",
    "js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs php pl lua sh bash zsh fish graphql yaml yml toml xml html htm css scss less patch diff service timer socket mount target path nginx dockerfile caddyfile gitignore gitattributes editorconfig rules",
    CodeXml,
  ],
] as const satisfies ReadonlyArray<readonly [string, string, LucideIcon]>;

const TYPES = new Map(
  FORMATS.flatMap(([kind, extensions, Icon]) =>
    extensions.split(" ").map((extension) => [extension, { kind, Icon }] as const),
  ),
);
const CODE_NAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "caddyfile",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".bashrc",
  ".zshrc",
]);

/** Presentation only: an icon never implies that a viewer or decoder is installed. */
function appearance(entry: FileIdentity) {
  if (entry.type === "symlink" && !(entry.link?.inside && entry.link.type === "file"))
    return { kind: "link", Icon: Link2, label: "" };
  if (entry.type === "other") return { kind: "other", Icon: FileQuestion, label: "" };
  const lower = entry.name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot > 0 ? lower.slice(dot + 1) : "";
  const format = CODE_NAMES.has(lower)
    ? { kind: "code", Icon: CodeXml }
    : (TYPES.get(extension) ?? { kind: "file", Icon: File });
  return {
    ...format,
    // Actual extensions are data, not translated category labels. Unusual names get a plain sheet.
    label: /^[a-z0-9]{1,5}$/.test(extension) ? extension.toUpperCase() : "",
  };
}

/** Layered document artwork at desktop size, with a simpler glyph in dense lists. */
export function FileTypeIcon({
  entry,
  size = 56,
  compact = false,
  className,
}: {
  entry: FileIdentity;
  size?: number;
  compact?: boolean;
  className?: string;
}) {
  const id = useId();
  const { kind, Icon, label } = appearance(entry);
  const linked = entry.type === "symlink" && kind !== "link";
  const showExtension = size >= 40 && label.length > 0;
  return (
    <span
      aria-hidden="true"
      data-file-icon={kind}
      data-compact={compact || undefined}
      className={cn("everyos-file-icon relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      {compact ? (
        <Icon className="size-full" strokeWidth={1.8} />
      ) : (
        <svg viewBox="0 0 64 64" fill="none" className="size-full overflow-visible">
          <defs>
            <linearGradient
              id={`${id}-face`}
              x1="12"
              y1="5"
              x2="49"
              y2="62"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="var(--file-tone-bright)" />
              <stop offset=".48" stopColor="var(--file-tone)" />
              <stop offset="1" stopColor="var(--file-tone-deep)" />
            </linearGradient>
            <linearGradient
              id={`${id}-fold`}
              x1="39"
              y1="5"
              x2="51"
              y2="20"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="white" stopOpacity=".92" />
              <stop offset="1" stopColor="white" stopOpacity=".42" />
            </linearGradient>
          </defs>
          <path
            d="M15 7h27a7 7 0 0 1 7 7v37a7 7 0 0 1-7 7H15a7 7 0 0 1-7-7V14a7 7 0 0 1 7-7Z"
            fill="var(--file-tone-bright)"
            fillOpacity=".3"
            stroke="var(--file-tone-bright)"
            strokeOpacity=".32"
            transform="rotate(-8 29 32)"
          />
          <path
            d="M19 6h19l15 15v32a8 8 0 0 1-8 8H19a8 8 0 0 1-8-8V14a8 8 0 0 1 8-8Z"
            fill="var(--file-shadow)"
            fillOpacity=".18"
            transform="translate(0 1.5)"
          />
          <path
            d="M19 5h19l15 15v32a8 8 0 0 1-8 8H19a8 8 0 0 1-8-8V13a8 8 0 0 1 8-8Z"
            fill={`url(#${id}-face)`}
          />
          <path
            d="M19 5.5h18.8L52.5 20.2V52a7.5 7.5 0 0 1-7.5 7.5H19a7.5 7.5 0 0 1-7.5-7.5V13A7.5 7.5 0 0 1 19 5.5Z"
            stroke="white"
            strokeOpacity=".27"
          />
          <path
            d="M38 5v10a5 5 0 0 0 5 5h10"
            fill="var(--file-shadow)"
            fillOpacity=".13"
            transform="translate(-.5 1.3)"
          />
          <path d="M38 5v9a6 6 0 0 0 6 6h9Z" fill={`url(#${id}-fold)`} />
          {showExtension ? (
            <path
              d="M11.5 46h41v6a7.5 7.5 0 0 1-7.5 7.5H19a7.5 7.5 0 0 1-7.5-7.5Z"
              fill="var(--file-shadow)"
              fillOpacity=".08"
            />
          ) : null}
          <svg
            x="16"
            y={showExtension ? 20 : 18}
            width="32"
            height={showExtension ? 26 : 32}
            viewBox="0 0 32 32"
            fill="none"
            overflow="visible"
          >
            <FileTypeArt kind={kind} fallback={Icon} />
          </svg>
          {showExtension ? (
            <text
              x="32"
              y="55.5"
              textAnchor="middle"
              fill="white"
              fontSize={label.length > 4 ? 7 : 8}
              fontWeight="750"
              letterSpacing="1"
              fontFamily="var(--font-sans, sans-serif)"
            >
              {label}
            </text>
          ) : null}
        </svg>
      )}
      {linked ? (
        <Link2
          className="absolute -bottom-0.5 -left-0.5 size-[35%] rounded-sm bg-[rgb(var(--everyos-surface))] text-fg"
          strokeWidth={2.2}
        />
      ) : null}
    </span>
  );
}
