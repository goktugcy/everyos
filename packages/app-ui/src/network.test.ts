import { BridgeError, createI18n, type NetFailure } from "@everyos/app-sdk";
import { describe, expect, it } from "vitest";
import { EVERYOS_LOCALES } from "./app.tsx";
import { UI_MESSAGES } from "./messages.ts";
import { networkMessage, networkProblem } from "./network.ts";

const failure = (code: string, details?: unknown) =>
  new BridgeError(code, "Internal transport message", details);
const failures: NetFailure[] = [
  "dns",
  "refused",
  "unreachable",
  "timeout",
  "reset",
  "tls",
  "too-many-redirects",
  "invalid-response",
  "error",
];

describe("network errors", () => {
  it("classifies blocked targets, including bracketed IPv6, and preserves the policy reason", () => {
    expect(
      networkProblem(
        failure("DESKTOP_APP_NETWORK_BLOCKED", {
          host: "api.example.com",
          port: 443,
          reason: "no-rule",
        }),
      ),
    ).toEqual({ kind: "blocked", target: "api.example.com:443", reason: "no-rule" });
    for (const host of ["2001:4860::1", "[2001:4860::1]"])
      expect(networkProblem(failure("DESKTOP_APP_NETWORK_BLOCKED", { host, port: 53 }))).toEqual({
        kind: "blocked",
        target: "[2001:4860::1]:53",
        reason: null,
      });
  });

  it("tolerates absent or malformed details without exposing the internal message", () => {
    for (const details of [undefined, null, "bad", [], { host: {}, port: 0 }, { port: 70000 }]) {
      expect(networkProblem(failure("DESKTOP_APP_NETWORK_BLOCKED", details))).toEqual({
        kind: "blocked",
        target: null,
        reason: null,
      });
      expect(networkProblem(failure("DESKTOP_APP_NETWORK_FAILED", details))).toEqual({
        kind: "failed",
        reason: "error",
      });
    }
    expect(
      networkProblem(failure("DESKTOP_APP_NETWORK_FAILED", { reason: "unrecognized" })),
    ).toEqual({ kind: "failed", reason: "error" });
    expect(networkProblem(failure("FORBIDDEN"))).toEqual({ kind: "forbidden" });
    expect(networkProblem(failure("RATE_LIMITED"))).toEqual({ kind: "rate-limited" });
    expect(networkProblem(new Error("no connection"))).toBeNull();
    expect(networkProblem({ code: "FORBIDDEN" })).toBeNull();
  });

  it.each(EVERYOS_LOCALES)(
    "explains every network failure in %s with complete translations",
    async (locale) => {
      const i18n = await createI18n({
        locale,
        supported: EVERYOS_LOCALES,
        load: (lang) => ({ ui: UI_MESSAGES[lang]! }),
      });
      const t = i18n.t.bind(i18n);
      const messages = failures.map((reason) =>
        networkMessage(t, failure("DESKTOP_APP_NETWORK_FAILED", { reason })),
      );
      messages.push(
        networkMessage(
          t,
          failure("DESKTOP_APP_NETWORK_BLOCKED", { host: "api.example.com", port: 443 }),
        ),
        networkMessage(t, failure("FORBIDDEN")),
        networkMessage(t, failure("RATE_LIMITED")),
      );
      expect(messages[failures.length]).toContain("api.example.com:443");
      for (const message of messages) {
        expect(message.length).toBeGreaterThan(5);
        expect(message).not.toMatch(/ui\.|\{\{|Internal transport/);
      }
      expect(new Set(messages).size).toBe(messages.length);
      expect(Object.keys(UI_MESSAGES[locale]!).sort()).toEqual(Object.keys(UI_MESSAGES.en!).sort());
      if (locale === "tr") {
        expect(messages[failures.length]).toContain("Uygulama Mağazası");
        expect(messages[failures.indexOf("timeout")]).toBe("Zamanında yanıt gelmedi.");
      }
      expect(
        networkMessage(t, failure("EVERYOS_PERMISSION_DENIED", { capability: "network:outbound" })),
      ).toContain("network:outbound");
      expect(networkMessage(t, failure("EVERYOS_CANCELLED"))).toBe("");
      expect(networkMessage(t, new Error("secret"))).toBe(t("ui.errorText"));
    },
  );
});
