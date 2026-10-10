import { describe, expect, it } from "vitest";
import {
  negotiateLocale,
  PERMISSIONS,
  permissionsForRole,
  roleHasPermission,
  ROLE_PERMISSIONS,
} from "./index.ts";

describe("roles", () => {
  it("gives administrators every permission", () => {
    expect(permissionsForRole("admin").sort()).toEqual([...PERMISSIONS].sort());
  });

  it("keeps viewers read-only on host resources while allowing personal preferences", () => {
    expect(roleHasPermission("viewer", "preferences:manage")).toBe(true);
    for (const permission of ROLE_PERMISSIONS.viewer) {
      if (permission === "preferences:manage") continue;
      expect(permission.endsWith(":read")).toBe(true);
    }
  });

  it("does not give operators administrative or terminal access", () => {
    for (const permission of [
      "users:manage",
      "settings:manage",
      "catalogs:manage",
      "terminal:access",
      "audit:read",
    ] as const) {
      expect(roleHasPermission("operator", permission)).toBe(false);
    }
    expect(roleHasPermission("operator", "docker:manage")).toBe(true);
  });

  it("makes every viewer permission available to operators", () => {
    for (const permission of ROLE_PERMISSIONS.viewer)
      expect(roleHasPermission("operator", permission)).toBe(true);
  });
});

describe("locale negotiation", () => {
  it("picks the first supported language and defaults to Turkish", () => {
    expect(negotiateLocale(["de-DE", "en-US"])).toBe("en");
    expect(negotiateLocale(["tr"])).toBe("tr");
    expect(negotiateLocale(["fr"])).toBe("tr");
  });
});
