export const VIDEO_TYPES = [".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mov", ".mkv", ".avi"];
export const isVideo = (name: string) => /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi)$/i.test(name);
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,64}$/.test(value);
export interface Playlist {
  id: string;
  name: string;
  ids: string[];
}
export interface VideoPreferences {
  lists: Playlist[];
  list: string;
  current: string | null;
  positions: Record<string, { seconds: number; at: number }>;
  subtitles: Record<string, string>;
  rate: number;
  volume: number;
  muted: boolean;
  captions: boolean;
}
export const playlistId = () =>
  [...crypto.getRandomValues(new Uint8Array(12))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
export const cleanName = (value: string) =>
  value
    .trim()
    .replace(/[\r\n\0]/g, " ")
    .slice(0, 80)
    .trim();
export function videoPreferences(value: unknown): VideoPreferences {
  const raw = value as Partial<VideoPreferences> | null;
  let lists = Array.isArray(raw?.lists)
    ? raw.lists
        .filter(
          (item) =>
            item && validId(item.id) && typeof item.name === "string" && Array.isArray(item.ids),
        )
        .slice(0, 20)
        .map((item) => ({
          id: item.id,
          name: cleanName(item.name),
          ids: [...new Set(item.ids.filter(validId))].slice(0, 100),
        }))
    : [];
  lists = [...new Map(lists.map((item) => [item.id, item])).values()];
  if (!lists.length) lists = [{ id: "default", name: "", ids: [] }];
  const list = lists.find((item) => item.id === raw?.list) ?? lists[0]!;
  const known = new Set(lists.flatMap((item) => item.ids));
  const positions =
    raw?.positions && typeof raw.positions === "object"
      ? Object.fromEntries(
          Object.entries(raw.positions)
            .filter(
              ([key, position]) =>
                known.has(key) &&
                position &&
                Number.isFinite(position.seconds) &&
                position.seconds >= 0 &&
                position.seconds <= 604800 &&
                Number.isFinite(position.at) &&
                position.at >= 0,
            )
            .toSorted((a, b) => b[1].at - a[1].at)
            .slice(0, 300)
            .map(([key, position]) => [key, { seconds: position.seconds, at: position.at }]),
        )
      : {};
  const subtitles =
    raw?.subtitles && typeof raw.subtitles === "object"
      ? Object.fromEntries(
          Object.entries(raw.subtitles)
            .filter(([key, id]) => known.has(key) && validId(id))
            .slice(0, 300),
        )
      : {};
  return {
    lists,
    list: list.id,
    current:
      typeof raw?.current === "string" && list.ids.includes(raw.current)
        ? raw.current
        : (list.ids[0] ?? null),
    positions,
    subtitles,
    rate:
      typeof raw?.rate === "number" &&
      Number.isFinite(raw.rate) &&
      raw.rate >= 0.25 &&
      raw.rate <= 4
        ? raw.rate
        : 1,
    volume:
      typeof raw?.volume === "number" &&
      Number.isFinite(raw.volume) &&
      raw.volume >= 0 &&
      raw.volume <= 1
        ? raw.volume
        : 1,
    muted: raw?.muted === true,
    captions: raw?.captions !== false,
  };
}
export const mimeOfVideo = (name: string): string =>
  ({
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    ogg: "video/ogg",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
  })[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";
export const CODECS = [
  'video/webm; codecs="vp8,vorbis"',
  'video/webm; codecs="vp9,opus"',
  'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
  'video/ogg; codecs="theora,vorbis"',
];
export function resumePosition(value: number, duration: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Number.isFinite(duration) && duration > 0
    ? Math.min(value, Math.max(0, duration - 0.1))
    : value;
}
export interface Caption {
  start: number;
  end: number;
  text: string;
}
function timestamp(value: string): number | null {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null;
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000;
  return seconds <= 604800 ? seconds : null;
}
/** Plain text only: cue markup is escaped; STYLE/REGION blocks are never applied. */
export function captions(text: string): Caption[] {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
    throw new RangeError("subtitle-limit");
  const blocks = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/);
  if (blocks.length > 10000) throw new RangeError("subtitle-limit");
  const result: Caption[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0] ?? "")) continue;
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const pair = lines[index]!.split("-->");
    const start = timestamp(pair[0]!.trim());
    const end = timestamp(pair[1]?.trim().split(/\s+/)[0] ?? "");
    const value = lines
      .slice(index + 1)
      .join("\n")
      .trim();
    if (start === null || end === null || end <= start || !value) continue;
    result.push({
      start,
      end,
      text: value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    });
    if (result.length > 2000) throw new RangeError("subtitle-limit");
  }
  if (!result.length) throw new SyntaxError("invalid-subtitles");
  return result;
}
