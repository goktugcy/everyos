// The probe's widget: the same app in a widget frame, limited to what the widget declares.
import { createApp, isBridgeError } from "../../../../packages/app-sdk/src/index.ts";

const show = (key: string, value: string) => {
  const element = document.querySelector(`[data-probe="${key}"]`);
  if (element) element.textContent = value;
};

const app = await createApp();
app.theme.apply();
show("widget", app.instance.kind);
// Shared with the app's windows: the widget declares storage:app.
show("widgetRuns", String((await app.storage.get<number>("runs")) ?? 0));
// Windows only: a widget cannot open the file picker.
try {
  await app.files.open({ accept: [".txt"] });
  show("widgetFiles", "allowed");
} catch (error) {
  show("widgetFiles", isBridgeError(error) ? error.code : "error");
}
await app.lifecycle.ready();
