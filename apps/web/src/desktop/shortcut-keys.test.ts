import { expect, it } from "vitest";
import { isDesktopShortcut } from "./shortcut-keys.ts";

it("reserves launcher, cycling and every desktop window command", () => {
  expect(isDesktopShortcut({ code: "KeyK", ctrlKey: true, metaKey: false, altKey: false })).toBe(
    true,
  );
  expect(isDesktopShortcut({ code: "KeyK", ctrlKey: false, metaKey: true, altKey: false })).toBe(
    true,
  );
  for (const code of ["Space", "Backquote"])
    expect(isDesktopShortcut({ code, ctrlKey: false, metaKey: false, altKey: true })).toBe(true);
  for (const code of [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "KeyW",
    "KeyT",
    "KeyL",
    "PageUp",
    "PageDown",
  ])
    expect(isDesktopShortcut({ code, ctrlKey: true, metaKey: false, altKey: true })).toBe(true);
});

it("leaves clipboard shortcuts, ordinary input and unreserved AltGr keys alone", () => {
  for (const code of ["KeyC", "KeyV", "KeyA", "KeyR", "KeyD"])
    expect(isDesktopShortcut({ code, ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
  expect(isDesktopShortcut({ code: "KeyK", ctrlKey: false, metaKey: false, altKey: false })).toBe(
    false,
  );
  expect(isDesktopShortcut({ code: "KeyQ", ctrlKey: true, metaKey: false, altKey: true })).toBe(
    false,
  );
  expect(isDesktopShortcut({ code: "KeyW", ctrlKey: false, metaKey: false, altKey: false })).toBe(
    false,
  );
});
