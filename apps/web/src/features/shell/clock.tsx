import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../lib/format.ts";

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
      {formatDateTime(now, i18n.language, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
      })}
    </time>
  );
}
