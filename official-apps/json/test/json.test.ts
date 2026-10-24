import { describe, expect, it } from "vitest";
import { diffJson } from "../src/diff.ts";
import { formatJson, minifyJson, parseJson, pathString, toCsv, type Json } from "../src/json.ts";
import { JsonPathError, query } from "../src/jsonpath.ts";

const error = (text: string) => {
  const result = parseJson(text);
  if (result.ok) throw new Error("expected an error");
  return result.error;
};

describe("parsing", () => {
  it("finds where and why invalid JSON fails", () => {
    expect(error('{"a": 1,}')).toMatchObject({ problem: "trailing-comma", line: 1, column: 9 });
    expect(error('{\n  "a": 1\n  "b": 2\n}')).toMatchObject({
      problem: "expected-comma",
      line: 3,
      column: 3,
    });
    expect(error("{'a': 1}")).toMatchObject({ problem: "expected-key", column: 2 });
    expect(error('{"a" 1}')).toMatchObject({ problem: "expected-colon" });
    expect(error('{"a": 01}')).toMatchObject({ problem: "expected-comma" });
    expect(error('["\\x"]')).toMatchObject({ problem: "bad-escape", column: 3 });
    expect(error('["a\tb"]')).toMatchObject({ problem: "bad-string" });
    expect(error("[1, 2")).toMatchObject({ problem: "unexpected-end" });
    expect(error("[1] x")).toMatchObject({ problem: "trailing-content", column: 5 });
    expect(error('{"a": tru}')).toMatchObject({ problem: "unexpected-character" });
    expect(error("   ")).toMatchObject({ problem: "empty" });
    expect(parseJson('{"ok": [1, "2", null, true]}')).toEqual({
      ok: true,
      value: { ok: [1, "2", null, true] },
    });
  });

  it("formats, sorts keys and minifies", () => {
    const value = { b: 1, a: { d: [1, 2], c: null } } as Json;
    expect(formatJson(value, 2, true)).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      1,\n      2\n    ]\n  },\n  "b": 1\n}',
    );
    expect(formatJson(value, "tab")).toContain('\n\t"b": 1');
    expect(minifyJson(value)).toBe('{"b":1,"a":{"d":[1,2],"c":null}}');
  });

  it("writes JSONPath paths", () => {
    expect(pathString(["store", "book", 0, "odd key", "it's"])).toBe(
      "$.store.book[0]['odd key']['it\\'s']".replace("\\'", "'"),
    );
    expect(pathString([])).toBe("$");
  });
});

const store: Json = {
  store: {
    book: [
      { title: "Sayings", price: 8.95, category: "reference" },
      { title: "Sword", price: 12.99, category: "fiction", isbn: "0-553" },
      { title: "Moby", price: 8.99, category: "fiction", isbn: "0-395" },
    ],
    bicycle: { color: "red", price: 19.95 },
  },
};
const values = (source: string) => query(store, source).map((match) => match.value);

describe("JSONPath", () => {
  it("selects members, elements, slices and wildcards", () => {
    expect(values("$.store.bicycle.color")).toEqual(["red"]);
    expect(values("$['store']['bicycle']['color']")).toEqual(["red"]);
    expect(values("$.store.book[-1].title")).toEqual(["Moby"]);
    expect(values("$.store.book[0,2].title")).toEqual(["Sayings", "Moby"]);
    expect(values("$.store.book[0:2].title")).toEqual(["Sayings", "Sword"]);
    expect(values("$.store.book[::-1].title")).toEqual(["Moby", "Sword", "Sayings"]);
    expect(values("$.store.book[*].price")).toEqual([8.95, 12.99, 8.99]);
    expect(values("$.store.*").length).toBe(2);
    expect(values("$.store.book.length")).toEqual([3]);
  });

  it("descends and filters", () => {
    expect(values("$..price")).toEqual([8.95, 12.99, 8.99, 19.95]);
    expect(values("$..book[?(@.price < 10)].title")).toEqual(["Sayings", "Moby"]);
    expect(values("$..book[?(@.isbn)].title")).toEqual(["Sword", "Moby"]);
    expect(values("$..book[?(@.category == 'fiction')].title")).toEqual(["Sword", "Moby"]);
    expect(values('$..book[?(@.category != "fiction")].title')).toEqual(["Sayings"]);
    expect(query(store, "$..book[1]")[0]!.path).toEqual(["store", "book", 1]);
  });

  it("explains invalid paths", () => {
    expect(() => query(store, "store")).toThrow(JsonPathError);
    expect(() => query(store, "$.store[")).toThrow(JsonPathError);
    expect(() => query(store, "$[1:2:0]")).toThrow(/step/);
    expect(() => query(store, "$[?(@.a ~ 1)]")).toThrow(JsonPathError);
  });
});

describe("diff and CSV", () => {
  it("lists added, removed and changed paths", () => {
    expect(
      diffJson({ a: 1, b: [1, 2], c: { d: true } }, { a: 2, b: [1], c: { d: true, e: null } }),
    ).toEqual([
      { path: ["a"], kind: "changed", before: 1, after: 2 },
      { path: ["b", 1], kind: "removed", before: 2 },
      { path: ["c", "e"], kind: "added", after: null },
    ]);
    expect(diffJson([1, { x: 1 }], [1, { x: 1 }])).toEqual([]);
  });

  it("converts arrays of objects to RFC 4180 CSV", () => {
    const { csv, columns } = toCsv([
      { name: "Ada", address: { city: "London" }, tags: ["a", "b"] },
      { name: 'Grace "Amazing" Hopper', note: "line\nbreak", address: { city: "New York, NY" } },
    ]);
    expect(columns).toEqual(["name", "address.city", "tags", "note"]);
    expect(csv).toBe(
      'name,address.city,tags,note\r\nAda,London,"[""a"",""b""]",\r\n"Grace ""Amazing"" Hopper","New York, NY",,"line\nbreak"\r\n',
    );
    expect(toCsv([1, "two"]).csv).toBe("value\r\n1\r\ntwo\r\n");
  });
});
