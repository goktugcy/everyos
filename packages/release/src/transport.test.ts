import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";

const fake = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("node:https", () => ({ get: fake.get }));
import { download } from "./transport.ts";

function connection(
  status: number,
  send: (response: EventEmitter) => void,
  headers: Record<string, string> = {},
) {
  fake.get.mockImplementation(
    (_url: URL, _options: unknown, ready: (response: IncomingMessage) => void) => {
      const request = Object.assign(new EventEmitter(), {
        setTimeout: (): EventEmitter => request,
        destroy: (error: Error): EventEmitter => {
          queueMicrotask(() => request.emit("error", error));
          return request;
        },
      });
      const response = Object.assign(new EventEmitter(), {
        statusCode: status,
        headers,
        destroy: (): EventEmitter => response,
      });
      queueMicrotask(() => {
        ready(response as unknown as IncomingMessage);
        send(response);
      });
      return request;
    },
  );
}
beforeEach(() => {
  fake.get.mockReset();
});
describe("bounded release transport failure paths", () => {
  it("rejects a connection interrupted after partial bytes", async () => {
    connection(200, (response) => {
      response.emit("data", Buffer.from("partial"));
      response.emit("aborted");
    });
    await expect(download(new URL("https://8.8.8.8/release.json"), 100)).rejects.toThrow(
      /interrupted/,
    );
  });
  it("checks public-address policy again even for an allowlisted redirect", async () => {
    connection(302, () => {}, { location: "https://127.0.0.1/release.json" });
    await expect(
      download(new URL("https://8.8.8.8/release.json"), 100, ["127.0.0.1"]),
    ).rejects.toThrow(/public/);
    expect(fake.get).toHaveBeenCalledTimes(1);
  });
  it("bounds response bytes and rejects malformed redirects", async () => {
    connection(200, (response) => response.emit("data", Buffer.alloc(101)));
    await expect(download(new URL("https://8.8.8.8/release.json"), 100)).rejects.toThrow(/large/);
    connection(302, () => {}, { location: "https://[invalid" });
    await expect(download(new URL("https://8.8.8.8/release.json"), 100)).rejects.toThrow(
      /redirect/,
    );
  });
  it("enforces the absolute deadline on a stalled response", async () => {
    connection(200, () => {});
    await expect(
      download(new URL("https://8.8.8.8/release.json"), 100, [], 0, Date.now() + 10),
    ).rejects.toThrow(/deadline/);
  });
});
