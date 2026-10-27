import { useEffect, useRef, useState } from "react";
import { app, i18n, useLanguage } from "./everyos.ts";

export function Notes() {
  useLanguage();
  const [note, setNote] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    void app.storage.get<string>("note").then((value) => setNote(value ?? ""));
  }, []);
  if (note === null) return <main aria-busy="true" />;
  const change = (value: string) => {
    setNote(value);
    setStatus(i18n.t("notes.saving"));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void app.storage
        .set("note", value)
        .then(() => setStatus(i18n.t("notes.saved", { count: value.length })));
    }, 400);
  };
  return (
    <main>
      <h1>{i18n.t("notes.title")}</h1>
      <textarea
        value={note}
        aria-label={i18n.t("notes.title")}
        placeholder={i18n.t("notes.placeholder")}
        onChange={(event) => change(event.target.value)}
      />
      <p className="status" role="status">
        {status}
      </p>
      <button type="button" onClick={() => void app.clipboard.writeText(note)}>
        {i18n.t("notes.copy")}
      </button>
    </main>
  );
}
