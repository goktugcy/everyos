type ShortcutKey = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey">;

/** Reserved desktop commands must reach the shell's global shortcut listener. */
export function isDesktopShortcut(event: ShortcutKey): boolean {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && event.code === "KeyK") return true;
  if (event.altKey && !mod && ["Space", "Backquote"].includes(event.code)) return true;
  return (
    event.ctrlKey &&
    event.altKey &&
    [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "KeyW",
      "KeyT",
      "KeyL",
      "PageUp",
      "PageDown",
    ].includes(event.code)
  );
}
