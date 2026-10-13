import { afterEach, expect, it, vi } from "vitest";
import { api, setCsrfToken } from "./api.ts";
import { subscribeApiTraffic, traceApiRequest, type ApiTraffic } from "./api-traffic.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

it("reports real UTF-8 content sizes and errors without retaining secrets or URLs", async () => {
  const response = JSON.stringify({ privateValue: "response-secret", value: "ğ" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(response, { status: 200 })));
  const entries: ApiTraffic[] = [];
  const unsubscribe = subscribeApiTraffic((entry) => entries.push(entry));
  try {
    setCsrfToken("csrf-secret");
    const body = { password: "password-secret", value: "ş" };
    await api("/files/private-file?token=query-secret", { method: "POST", body });
    expect(entries[0]).toMatchObject({
      method: "POST",
      resource: "files",
      status: 200,
      sentBytes: new TextEncoder().encode(JSON.stringify(body)).length,
      receivedBytes: new TextEncoder().encode(response).length,
    });
    expect(JSON.stringify(entries)).not.toMatch(/secret|private-file|password|privateValue/);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(api("/system/network")).rejects.toMatchObject({ code: "NETWORK" });
    expect(entries[1]).toMatchObject({ status: 0, receivedBytes: null, resource: "system" });
  } finally {
    unsubscribe();
  }
});

it("does not replay closed-view or previous-session requests into a new viewer", () => {
  const first = vi.fn();
  const unsubscribe = subscribeApiTraffic(first);
  const pending = traceApiRequest("GET", "/auth/session?token=secret", 0);
  unsubscribe();
  const next = vi.fn();
  const closeNext = subscribeApiTraffic(next);
  try {
    pending(200, 123);
    expect(first).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    traceApiRequest("GET", "/unknown-secret-resource", 0)(204, 0);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ resource: "api", status: 204 }));
  } finally {
    closeNext();
  }
});
