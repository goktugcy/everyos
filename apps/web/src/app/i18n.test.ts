import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClientModule from "@everyos/i18n/client";
import { tr } from "../../../../packages/i18n/src/locales/tr.ts";

const loaders = vi.hoisted(() => ({ de: vi.fn(), tr: vi.fn() }));
vi.mock("@everyos/i18n/client", async (original) => ({
  ...(await original<typeof ClientModule>()),
  loadMessages: loaders,
}));

const setItem = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem });
});
afterEach(() => vi.unstubAllGlobals());

describe("language loading", () => {
  it("keeps the latest choice when an earlier language finishes downloading later", async () => {
    const slow = Promise.withResolvers<typeof tr>();
    loaders.de.mockReturnValue(slow.promise);
    loaders.tr.mockResolvedValue(tr);
    const { applyLocale, i18nReady, i18next } = await import("./i18n.ts");
    await i18nReady;

    applyLocale("de");
    applyLocale("tr");
    await vi.waitFor(() => expect(i18next.language).toBe("tr"));
    slow.resolve(tr);
    await vi.waitFor(() => expect(i18next.hasResourceBundle("de", "translation")).toBe(true));
    expect(i18next.language).toBe("tr");
    expect(document.documentElement.lang).toBe("tr");
    expect(setItem).toHaveBeenLastCalledWith("everyos.locale", "tr");
  });

  it("keeps the current language after a failed download and retries the next choice", async () => {
    loaders.de.mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(tr);
    const { applyLocale, i18nReady, i18next } = await import("./i18n.ts");
    await i18nReady;
    applyLocale("de");
    await vi.waitFor(() => expect(loaders.de).toHaveBeenCalledTimes(1));
    expect(i18next.language).toBe("en");
    expect(setItem).toHaveBeenLastCalledWith("everyos.locale", "en");
    applyLocale("de");
    await vi.waitFor(() => expect(i18next.language).toBe("de"));
    expect(loaders.de).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight language download", async () => {
    const slow = Promise.withResolvers<typeof tr>();
    loaders.de.mockReturnValue(slow.promise);
    const { applyLocale, i18nReady, i18next } = await import("./i18n.ts");
    await i18nReady;
    applyLocale("de");
    applyLocale("de");
    await vi.waitFor(() => expect(loaders.de).toHaveBeenCalledTimes(1));
    slow.resolve(tr);
    await vi.waitFor(() => expect(i18next.language).toBe("de"));
  });
});
