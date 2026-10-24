import { createApp, createI18n } from "@everyos/app-sdk";
import "./styles.css";

const app = await createApp();
app.theme.apply();
const i18n = await createI18n({ locale: app.locale.current, supported: ["en", "tr"] });

const root = document.querySelector<HTMLElement>("#app")!;
const title = document.createElement("h1");
const note = document.createElement("textarea");
const status = document.createElement("p");
status.className = "status";
status.setAttribute("role", "status");
const copy = document.createElement("button");
copy.type = "button";
root.append(title, note, status, copy);

function render(): void {
  title.textContent = i18n.t("notes.title");
  note.placeholder = i18n.t("notes.placeholder");
  note.setAttribute("aria-label", i18n.t("notes.title"));
  copy.textContent = i18n.t("notes.copy");
}
render();
app.locale.onChange((locale) => void i18n.setLocale(locale).then(render));

note.value = (await app.storage.get<string>("note")) ?? "";
let timer: ReturnType<typeof setTimeout> | undefined;
note.addEventListener("input", () => {
  clearTimeout(timer);
  status.textContent = i18n.t("notes.saving");
  timer = setTimeout(() => {
    const value = note.value;
    void app.storage.set("note", value).then(() => {
      status.textContent = i18n.t("notes.saved", { count: value.length });
    });
  }, 400);
});
copy.addEventListener("click", () => void app.clipboard.writeText(note.value));
await app.lifecycle.ready();
