import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogFetcher } from "./fetch.ts";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request }));
afterEach(() => request.mockReset());

const index = "https://github.com/goktugcy/everyos/releases/latest/download/official-apps.json";
const release = "https://github.com/goktugcy/everyos/releases/download/v1.0.0/official-apps.json";
const object = "https://objects.githubusercontent.com/github-production-release-asset/1/index";

describe("GitHub release asset transport", () => {
  function transport(firstRedirect = release) {
    const seen: Array<{ url: string; headers: RequestOptions["headers"]; address: string }> = [];
    request.mockImplementation(
      (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
        const req = new EventEmitter();
        Object.assign(req, {
          setTimeout: () => req,
          end: () => {
            options.lookup!(url.hostname, { all: false }, (error, address) => {
              expect(error).toBeNull();
              if (typeof address !== "string") throw new Error("Expected one pinned address");
              seen.push({ url: url.href, headers: options.headers, address });
            });
            const stream = new PassThrough();
            const response = stream as unknown as IncomingMessage;
            response.statusCode = url.href === object ? 200 : 302;
            response.headers =
              url.href === object ? {} : { location: url.href === index ? firstRedirect : object };
            callback(response);
            if (response.statusCode === 200) stream.end("signed-index");
          },
        });
        return req;
      },
    );
    return seen;
  }

  it("follows latest and object redirects, checking and pinning public DNS at every hop", async () => {
    const seen = transport();
    const resolve = vi.fn((host: string) =>
      Promise.resolve([
        { address: host === "github.com" ? "140.82.112.3" : "185.199.108.133", family: 4 },
      ]),
    );
    const fetcher = createCatalogFetcher({
      resolve,
      authorization: { origin: "https://github.com", value: "Bearer fixture-token" },
    });
    expect((await fetcher.get(index)).toString()).toBe("signed-index");
    expect(resolve.mock.calls.map(([host]) => host)).toEqual([
      "github.com",
      "github.com",
      "objects.githubusercontent.com",
    ]);
    expect(seen.map(({ url, address }) => [url, address])).toEqual([
      [index, "140.82.112.3"],
      [release, "140.82.112.3"],
      [object, "185.199.108.133"],
    ]);
    expect(seen.map(({ headers }) => (headers as Record<string, string>).Authorization)).toEqual([
      "Bearer fixture-token",
      "Bearer fixture-token",
      undefined,
    ]);
  });

  it.each(["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1"])(
    "refuses an object redirect resolving to %s before connecting",
    async (address) => {
      const seen = transport();
      const fetcher = createCatalogFetcher({
        resolve: (host) =>
          Promise.resolve(
            host === "github.com"
              ? [{ address: "140.82.112.3", family: 4 }]
              : [
                  { address: "185.199.108.133", family: 4 },
                  { address, family: address.includes(":") ? 6 : 4 },
                ],
          ),
      });
      await expect(fetcher.get(index)).rejects.toThrow("unsafe-address");
      expect(seen.map(({ url }) => url)).toEqual([index, release]);
    },
  );

  it.each([release, "http://example.com/index.json", "https://example.com/index.json"])(
    "identity probes refuse a redirect to %s before resolving or connecting again",
    async (target) => {
      const seen = transport(target);
      const resolve = vi.fn(() => Promise.resolve([{ address: "140.82.112.3", family: 4 }]));
      const fetcher = createCatalogFetcher({ resolve, allowRedirects: false });
      await expect(fetcher.get(index)).rejects.toThrow("redirect-not-allowed");
      expect(seen.map(({ url }) => url)).toEqual([index]);
      expect(resolve).toHaveBeenCalledTimes(1);
    },
  );
});
