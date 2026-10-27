import { beforeEach, describe, expect, it, vi } from "vitest";
import { findExecutable, runCommand, streamLines } from "../exec.ts";
import { createJournalSource } from "./journal-client.ts";

vi.mock("../exec.ts", () => ({
  findExecutable: vi.fn(),
  runCommand: vi.fn(),
  streamLines: vi.fn(),
}));

const line = JSON.stringify({
  __CURSOR: "cursor-1",
  __REALTIME_TIMESTAMP: "1700000000000000",
  MESSAGE: "Cache [main]. failed",
  PRIORITY: "3",
  _SYSTEMD_UNIT: "cache.service",
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(findExecutable).mockResolvedValue("/usr/bin/journalctl");
  vi.mocked(runCommand).mockResolvedValue(line);
  vi.mocked(streamLines).mockImplementation(async function* () {
    yield await Promise.resolve(line);
  });
});

describe("journal message searches", () => {
  it("treats message search metacharacters literally while retaining bounded read-only arguments", async () => {
    const text = "Cache [main]. (failed)+? ^$ | back\\slash";
    const result = await createJournalSource().query({
      grep: text,
      unit: "cache.service",
      limit: 200,
    });
    const [bin, args, options] = vi.mocked(runCommand).mock.calls[0]!;
    const pattern = args.find((arg) => arg.startsWith("--grep="))!.slice(7);
    expect(new RegExp(pattern, "i").test(`prefix ${text.toUpperCase()} suffix`)).toBe(true);
    expect(new RegExp(pattern, "i").test("Cache mainX failed backslash")).toBe(false);
    expect(bin).toBe("/usr/bin/journalctl");
    expect(args).toContain("--unit=cache.service");
    expect(args).toContain("--case-sensitive=false");
    expect(args).toContain("--lines=201");
    expect(options).toMatchObject({ timeoutMs: 15000, maxBytes: 32 * 1024 * 1024 });
    expect(result).toMatchObject({
      source: "host",
      entries: [{ cursor: "cursor-1", message: "Cache [main]. failed" }],
      hasMore: false,
    });
  });

  it("keeps live searches literal too and does not apply history bounds to the follow stream", async () => {
    const signal = new AbortController().signal;
    const entries = [];
    for await (const entry of createJournalSource().follow(
      { grep: "[main].", since: 1000, until: 2000 },
      signal,
    ))
      entries.push(entry);
    const [, args, options] = vi.mocked(streamLines).mock.calls[0]!;
    const pattern = args.find((arg) => arg.startsWith("--grep="))!.slice(7);
    expect(new RegExp(pattern, "i").test("Cache [MAIN]. failed")).toBe(true);
    expect(new RegExp(pattern, "i").test("mainX failed")).toBe(false);
    expect(args).toContain("--follow");
    expect(args.some((arg) => arg.startsWith("--since=") || arg.startsWith("--until="))).toBe(
      false,
    );
    expect(options).toMatchObject({ signal, maxLineBytes: 64 * 1024 });
    expect(entries).toHaveLength(1);
  });

  it("reports a missing journal collector without trying another command", async () => {
    vi.mocked(findExecutable).mockResolvedValue(null);
    await expect(createJournalSource().query({ limit: 200 })).rejects.toMatchObject({
      name: "LogSourceUnavailableError",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
