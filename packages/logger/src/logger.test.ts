import { describe, expect, it } from "vitest";
import { createLogger } from "./index.ts";

function capture() {
  const lines: string[] = [];
  return { lines, sink: { write: (line: string) => lines.push(line) } };
}

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

describe("logger", () => {
  it("writes structured JSON lines with bindings", () => {
    const { lines, sink } = capture();
    const log = createLogger({ name: "api", sink, syslogPrefix: false, now: fixedNow }).child({
      requestId: "r1",
    });
    log.info("hello", { userId: "u1" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      time: "2026-01-01T00:00:00.000Z",
      level: "info",
      name: "api",
      msg: "hello",
      requestId: "r1",
      userId: "u1",
    });
  });

  it("redacts secret-looking keys at any depth", () => {
    const { lines, sink } = capture();
    const log = createLogger({ name: "api", sink, syslogPrefix: false });
    log.info("login", {
      password: "hunter2",
      nested: { sessionToken: "abc", ok: 1 },
      list: [{ secret: "s" }],
    });
    const record = JSON.parse(lines[0]!);
    expect(record.password).toBe("[redacted]");
    expect(record.nested).toEqual({ sessionToken: "[redacted]", ok: 1 });
    expect(record.list).toEqual([{ secret: "[redacted]" }]);
    expect(lines[0]).not.toContain("hunter2");
  });

  it("respects the level threshold", () => {
    const { lines, sink } = capture();
    const log = createLogger({ name: "api", sink, level: "warn" });
    log.info("ignored");
    log.debug("ignored");
    log.warn("kept");
    expect(lines).toHaveLength(1);
  });

  it("adds a syslog priority prefix for journald", () => {
    const { lines, sink } = capture();
    const log = createLogger({ name: "agent", sink, syslogPrefix: true });
    log.error("boom");
    expect(lines[0]!.startsWith("<3>{")).toBe(true);
  });

  it("serializes errors and survives circular structures", () => {
    const { lines, sink } = capture();
    const log = createLogger({ name: "api", sink, syslogPrefix: false });
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    log.error("failed", { err: new Error("nope"), circular });
    const record = JSON.parse(lines[0]!);
    expect(record.err.message).toBe("nope");
    expect(record.circular.self).toBe("[circular]");
  });
});
