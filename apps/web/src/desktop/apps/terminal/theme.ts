import type { ITerminalOptions } from "@xterm/xterm";

/** Read resolved CSS tokens, including custom themes and accessibility scaling. */
export function terminalOptions(element: HTMLElement): ITerminalOptions {
  const style = getComputedStyle(element);
  const color = (name: string) =>
    `rgb(${style.getPropertyValue(`--everyos-${name}`).trim().split(/\s+/).join(",")})`;
  return {
    fontFamily: style.fontFamily,
    fontSize: Number.parseFloat(style.fontSize),
    theme: {
      background: color("surface"),
      foreground: color("text"),
      cursor: color("accent"),
      cursorAccent: color("surface"),
      selectionBackground: `rgba(${style.getPropertyValue("--everyos-accent").trim().split(/\s+/).join(",")},0.3)`,
      black: color("text-subtle"),
      red: color("danger"),
      green: color("success"),
      yellow: color("warning"),
      blue: color("accent-strong"),
      magenta: color("danger"),
      cyan: color("accent"),
      white: color("text"),
      brightBlack: color("text-muted"),
      brightRed: color("danger"),
      brightGreen: color("success"),
      brightYellow: color("warning"),
      brightBlue: color("accent-strong"),
      brightMagenta: color("danger"),
      brightCyan: color("accent"),
      brightWhite: color("text"),
    },
  };
}
