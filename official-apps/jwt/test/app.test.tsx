import { renderApp, type RenderedApp } from "@everyos/app-ui/testing";
import { byRole, byText, typeInto } from "@everyos/app-testing/dom";
import { SignJWT } from "jose";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JwtApp } from "../src/jwt-app.tsx";

const publicDir = join(import.meta.dirname, "../public");
let rendered: RenderedApp | null = null;
afterEach(() => {
  rendered?.unmount();
  rendered = null;
});
const SECRET = "a shared secret that is long enough";
const settle = () => new Promise((resolve) => setTimeout(resolve));

async function token(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(SECRET));
}

async function start(locale = "en", storage: Record<string, unknown> = {}) {
  rendered = await renderApp(JwtApp, {
    publicDir,
    app: { id: "dev.everyos.jwt", version: "1.0.0", name: "JWT Inspector" },
    granted: ["storage:app", "clipboard:write", "files:save"],
    locale,
    storage,
  });
  await vi.waitFor(() => expect(document.querySelector(".jwt-token")).not.toBeNull());
  return rendered;
}
const field = () => document.querySelector<HTMLTextAreaElement>(".jwt-token")!;

describe("JWT Inspector", () => {
  it("decodes a token, shows its claims and whether it is still valid", async () => {
    const { host } = await start("tr");
    const exp = Math.floor(Date.now() / 1000) - 3600;
    typeInto(field(), await token({ sub: "ada", email: "ada@example.com", exp }));
    await vi.waitFor(() => expect(byText(/Süresi .* doldu/)).not.toBeNull());
    expect(byText("Konu (token'ın ilgili olduğu kişi)")).not.toBeNull();
    expect(byText("ada@example.com", "td")).not.toBeNull();
    // Not remembered unless asked.
    await settle();
    expect(host.storage.has("token")).toBe(false);
  });

  it("verifies the signature with the secret the person gives", async () => {
    await start();
    typeInto(field(), await token({ sub: "ada" }));
    await settle();
    byRole("tab", "Verify signature")!.click();
    await vi.waitFor(() => expect(byRole("textbox", "Secret")).not.toBeNull());
    typeInto(byRole("textbox", "Secret"), "wrong");
    await settle();
    byRole("button", "Check the signature")!.click();
    await vi.waitFor(() => expect(byText("Signature does not match this key")).not.toBeNull());
    typeInto(byRole("textbox", "Secret"), SECRET);
    await settle();
    byRole("button", "Check the signature")!.click();
    await vi.waitFor(() => expect(byText("Signature valid (HS256)")).not.toBeNull());
  });

  it("exports claims with personal ones redacted", async () => {
    const { host } = await start();
    typeInto(field(), await token({ sub: "ada", email: "ada@example.com", role: "admin" }));
    await settle();
    byRole("tab", "Export")!.click();
    await vi.waitFor(() => expect(byRole("button", "Copy")).not.toBeNull());
    await settle();
    byRole("button", "Copy")!.click();
    await vi.waitFor(() => expect(host.clipboard).toHaveLength(1));
    const exported = JSON.parse(host.clipboard[0]!) as { payload: Record<string, unknown> };
    expect(exported.payload).toEqual({ sub: "[redacted]", email: "[redacted]", role: "admin" });
  });

  it("remembers the last token only when asked", async () => {
    const { host } = await start();
    byRole("switch", "Remember the last token")!.click();
    const value = await token({ sub: "x" });
    typeInto(field(), value);
    await vi.waitFor(() => expect(host.storage.get("token")).toBe(value));
    byRole("switch", "Remember the last token")!.click();
    await vi.waitFor(() => expect(host.storage.has("token")).toBe(false));
  });
});
