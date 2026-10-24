import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { app, i18n, useLanguage } from "./everyos.ts";
import "./widget.css";

/** The widget: the same app in a small frame, with only the capabilities the widget declares. */
function Summary() {
  useLanguage();
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void app.storage.get<string>("note").then((value) => setNote(value ?? ""));
    load();
    // The window saves as people type; the widget catches up when it shows again and every 5 s.
    const stop = app.lifecycle.onResume(load);
    const timer = setInterval(load, 5000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, []);
  return (
    <button type="button" className="summary" onClick={() => void app.window.open()}>
      <strong>{i18n.t("widgets.summary.name")}</strong>
      <span>{note === null ? "" : note ? note.slice(0, 120) : i18n.t("widget.empty")}</span>
    </button>
  );
}

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <Summary />
  </StrictMode>,
);
await app.lifecycle.ready();
