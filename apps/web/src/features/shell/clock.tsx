import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { localeTag } from "../../lib/format.ts";

/** macOS order: "Paz 11 Eki 14:33" (weekday, day, month, then the time). */
export function menubarTime(now: number, language: string, seconds: boolean): string {
  const tag = localeTag(language);
  const date = new Date(now);
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(tag, options).format(date);
  const time = part({
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
  return `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })} ${time}`;
}

/**
 * Menu bar clock. Without seconds it re-renders once per minute, aligned to
 * the minute boundary, to avoid needless work.
 */
export function Clock({ seconds = false }: { seconds?: boolean }) {
  const { i18n } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const period = seconds ? 1_000 : 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, period - (Date.now() % period) + 20);
    };
    timer = setTimeout(tick, period - (Date.now() % period) + 20);
    return () => clearTimeout(timer);
  }, [seconds]);

  return (
    <time dateTime={new Date(now).toISOString()} className="tabular-nums">
      {menubarTime(now, i18n.language, seconds)}
    </time>
  );
}
