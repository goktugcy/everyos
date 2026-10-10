import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../lib/format.ts";

/** Menu bar clock; re-renders once per minute, aligned to the minute boundary. */
export function Clock() {
  const { i18n } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    return () => clearTimeout(timer);
  }, []);

  return (
    <time dateTime={new Date(now).toISOString()} className="tabular-nums">
      {formatDateTime(now, i18n.language, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
