import { AlertDialog } from "radix-ui";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Button } from "../../components/ui/button.tsx";
import type { ConfirmOptions } from "./menu-model.ts";

interface ConfirmState {
  request: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
}

const useConfirmStore = create<ConfirmState>()(() => ({ request: null }));

/** Asks the user to confirm a dangerous action. Resolves to true when confirmed. */
export function requestConfirm(options: ConfirmOptions): Promise<boolean> {
  useConfirmStore.getState().request?.resolve(false);
  return new Promise((resolve) => useConfirmStore.setState({ request: { ...options, resolve } }));
}

/** Renders the pending confirmation (mounted once by the shell). */
export function ConfirmHost() {
  const { t } = useTranslation();
  const request = useConfirmStore((state) => state.request);
  const finish = (ok: boolean) => {
    request?.resolve(ok);
    useConfirmStore.setState({ request: null });
  };
  return (
    <AlertDialog.Root open={request !== null} onOpenChange={(open) => !open && finish(false)}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[9000] bg-black/40" />
        <AlertDialog.Content className="glass-strong otk-enter fixed left-1/2 top-1/2 z-[9001] flex w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-otk-lg p-6">
          <AlertDialog.Title className="text-lg font-semibold">{request?.title}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm leading-relaxed text-fg-muted">
            {request?.body}
          </AlertDialog.Description>
          <div className="flex justify-end gap-3 pt-1">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">{t("confirmDialog.cancel")}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant={request?.danger === false ? "primary" : "danger"}
                onClick={() => finish(true)}
              >
                {request?.confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
