// End-to-end probe app: built with the real SDK, it reports what it could and could not do.
import { createApp, createI18n, isBridgeError } from "../../../../packages/app-sdk/src/index.ts";

const show = (key: string, value: string) => {
  const element = document.querySelector(`[data-probe="${key}"]`);
  if (element) element.textContent = value;
};

/** What the sandbox must prevent: each should report "blocked". */
async function probeSandbox(): Promise<void> {
  try {
    void window.parent.document.title;
    show("parentDom", "open");
  } catch {
    show("parentDom", "blocked");
  }
  try {
    show("cookie", document.cookie ? "visible" : "empty");
  } catch {
    show("cookie", "blocked");
  }
  try {
    localStorage.setItem("probe", "1");
    show("localStorage", "open");
  } catch {
    show("localStorage", "blocked");
  }
  try {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    show("api", `status ${response.status}`);
  } catch {
    show("api", "blocked");
  }
}

const app = await createApp();
app.theme.apply();
const i18n = await createI18n({ locale: app.locale.current, supported: ["en", "tr"] });
await app.window.setTitle(`${i18n.t("app.name")} ready`);
const runs = ((await app.storage.get<number>("runs")) ?? 0) + 1;
await app.storage.set("runs", runs);
show("connected", "yes");
show("runs", String(runs));
show("locale", app.locale.current);
show("scheme", app.theme.current.scheme);
app.locale.onChange((locale) => show("locale", locale));
// Not granted: the server must refuse it whatever the app claims.
try {
  await app.host.call("system.metrics");
  show("forbidden", "allowed");
} catch (error) {
  show("forbidden", isBridgeError(error) ? error.code : "error");
}
await probeSandbox();
document.querySelector('[data-action="ask"]')?.addEventListener("click", () => {
  void app.dialogs
    .confirm(i18n.t("ask"), "", { destructive: true })
    .then((answer) => show("answer", answer ? "confirmed" : "cancelled"));
});
document.querySelector('[data-action="open"]')?.addEventListener("click", () => {
  void app.files.open({ accept: [".txt"] }).then(async (handles) => {
    const [handle] = handles;
    show("opened", handle ? await app.files.readText(handle) : "cancelled");
  });
});
document.querySelector('[data-action="save"]')?.addEventListener("click", () => {
  void app.files.save({ suggestedName: "probe-output.txt" }).then(async (handle) => {
    show(
      "saved",
      handle ? String(await app.files.write(handle, "written by the probe")) : "cancelled",
    );
  });
});
await app.lifecycle.ready();
