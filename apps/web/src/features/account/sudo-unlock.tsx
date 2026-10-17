import { KeyRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { ApiRequestError } from "../../lib/api.ts";
import { LinuxAccountSection } from "./linux-account.tsx";

/** After a root action failed for want of a linked, sudo-unlocked Linux account, offers the fix. */
export function SudoUnlock({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const reason =
    error instanceof ApiRequestError
      ? (error.details as { reason?: string } | undefined)?.reason
      : undefined;
  if (reason !== "LINUX_SUDO_REQUIRED" && reason !== "LINUX_ACCOUNT_REQUIRED") return null;
  return (
    <>
      <span>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <KeyRound className="size-4" aria-hidden />
          {t("linux.unlock")}
        </Button>
      </span>
      <Dialog open={open} onOpenChange={setOpen} title={t("linux.unlock")}>
        {open ? <LinuxAccountSection /> : null}
      </Dialog>
    </>
  );
}
