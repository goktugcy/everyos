import type { AppAction, AppJobView, InstalledAppView } from "@everyos/shared";
import type { TFunction } from "i18next";
import { api } from "../../../lib/api.ts";
import { requestConfirm } from "../../menus/confirm.tsx";
import { localized } from "../localized.ts";

/** Both the folder and management card use the same explicit lifecycle confirmation. */
export async function requestAppAction(
  app: InstalledAppView,
  action: Exclude<AppAction, "install">,
  t: TFunction,
  locale: string,
): Promise<AppJobView | null> {
  if (
    action !== "start" &&
    !(await requestConfirm({
      title: t("appStore.confirmTitle", {
        name: localized(app.name, locale),
        action: t(`appStore.actions.${action}`),
      }),
      body: t(
        action === "remove"
          ? "appStore.removeBody"
          : action === "update"
            ? "appStore.updateBody"
            : "appStore.confirmBody",
      ),
      confirmLabel: t(`appStore.actions.${action}`),
      danger: action === "remove",
    }))
  )
    return null;
  return api<AppJobView>(`/apps/${app.id}/actions`, {
    method: "POST",
    body: { action, confirmId: app.id },
  });
}
