import type { Terminal } from "@xterm/xterm";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "../../../components/ui/alert.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { copyText } from "../../../lib/clipboard.ts";
import { ContextMenuArea } from "../../menus/menus.tsx";
import type { MenuEntry } from "../../menus/menu-model.ts";

/** A real text field supplies native selection handles and paste even without Clipboard API access. */
export function TerminalClipboard({
  terminal,
  connected,
  children,
}: {
  terminal: RefObject<Terminal | null>;
  connected: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"selection" | "paste" | null>(null);
  const [text, setText] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const close = () => {
    setMode(null);
    setText("");
    setCopyFailed(false);
  };
  const selectText = (selection?: string) => {
    let output = selection ?? "";
    if (!selection && terminal.current) {
      const buffer = terminal.current.buffer.active;
      for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index);
        if (line) output += (index && !line.isWrapped ? "\n" : "") + line.translateToString(true);
      }
    }
    setText(selection ?? output.replace(/\n+$/, ""));
    setCopyFailed(false);
    setMode("selection");
  };
  const paste = (value: string) => {
    if (!connected || !terminal.current || terminal.current.options.disableStdin) return;
    terminal.current.paste(value);
    terminal.current.focus();
  };
  const readClipboard = async () => {
    if (navigator.clipboard?.readText) {
      try {
        paste(await navigator.clipboard.readText());
        return;
      } catch {
        // HTTP and browser permission policies may require pasting into a normal text field.
      }
    }
    setText("");
    setCopyFailed(false);
    setMode("paste");
  };
  const entries = (): MenuEntry[] => [
    {
      kind: "item",
      id: "copy",
      label: t("common.copy"),
      disabled: !terminal.current?.hasSelection(),
      onSelect: () => {
        const selection = terminal.current?.getSelection();
        if (selection)
          void copyText(selection).then((copied) => {
            if (!copied) selectText(selection);
          });
      },
    },
    {
      kind: "item",
      id: "paste",
      label: t("files.menu.paste"),
      disabled: !connected,
      onSelect: () => void readClipboard(),
    },
    { kind: "separator", id: "selection" },
    {
      kind: "item",
      id: "select-all",
      label: t("files.selectAll"),
      onSelect: () => terminal.current?.selectAll(),
    },
    {
      kind: "item",
      id: "select-text",
      label: t("terminal.selectText"),
      onSelect: () => selectText(),
    },
  ];
  return (
    <>
      <ContextMenuArea entries={entries} onCloseAutoFocus={(event) => event.preventDefault()}>
        <div
          className="flex min-h-0 flex-1 flex-col"
          onTouchEndCapture={(event) => {
            // Releasing a long press must not synthesize a click that refocuses xterm.
            if (event.currentTarget.dataset.state === "open") event.preventDefault();
          }}
          onContextMenuCapture={(event) => {
            if (event.target === event.currentTarget) return;
            // xterm's native handler focuses its hidden textarea and dismisses the touch menu.
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                button: 2,
                clientX: event.clientX,
                clientY: event.clientY,
              }),
            );
          }}
        >
          {children}
        </div>
      </ContextMenuArea>
      {mode ? (
        <Dialog
          open
          onOpenChange={(open) => !open && close()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            terminal.current?.focus();
          }}
          title={mode === "paste" ? t("files.menu.paste") : t("terminal.selectText")}
          description={t(mode === "paste" ? "terminal.pasteHint" : "terminal.selectHint")}
          footer={
            mode === "paste" ? (
              <Button
                disabled={!connected || !text}
                onClick={() => {
                  paste(text);
                  close();
                }}
              >
                {t("files.menu.paste")}
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    field.current?.focus();
                    field.current?.select();
                  }}
                >
                  {t("files.selectAll")}
                </Button>
                <Button
                  disabled={!text}
                  onClick={() => {
                    const input = field.current;
                    const value =
                      input && input.selectionEnd > input.selectionStart
                        ? text.slice(input.selectionStart, input.selectionEnd)
                        : text;
                    void copyText(value).then((copied) => setCopyFailed(!copied));
                  }}
                >
                  {t("common.copy")}
                </Button>
              </>
            )
          }
        >
          <textarea
            ref={field}
            autoFocus
            aria-label={mode === "paste" ? t("terminal.input") : t("terminal.selectText")}
            readOnly={mode === "selection"}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            style={{ WebkitTouchCallout: "default" }}
            className="glass-inset h-48 w-full resize-y select-text rounded-everyos-sm border border-line p-3 font-mono text-sm outline-none focus:ring-2 focus:ring-accent"
          />
          {copyFailed ? <Alert>{t("common.copyFailed")}</Alert> : null}
        </Dialog>
      ) : null}
    </>
  );
}
