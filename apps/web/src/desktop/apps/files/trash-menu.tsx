import { useTranslation } from "react-i18next";
import type { MenuEntry } from "../../menus/menu-model.ts";
import { TrashGlyph } from "./trash-glyph.tsx";
import { useTrashActions } from "./trash-status.tsx";

export function useTrashMenu(): () => MenuEntry[] {
  const { t } = useTranslation();
  const { listing, enabled, busy, empty } = useTrashActions();
  const knownEmpty =
    !listing.error && listing.data?.entries.length === 0 && !listing.data.truncated;
  return () => [
    {
      kind: "item",
      id: "empty-trash",
      label: t("trash.emptyAction"),
      icon: <TrashGlyph />,
      permission: "files:write",
      danger: true,
      disabled: !enabled || busy || knownEmpty,
      onSelect: () => {
        void empty();
      },
    },
  ];
}
