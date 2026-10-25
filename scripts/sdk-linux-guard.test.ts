import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("refuses real hosts, self-hosted runners and untrusted or replayed CI markers", async () => {
  const result = await promisify(execFile)(
    "python3",
    ["-m", "unittest", "discover", "-s", "tests/sdk-linux", "-p", "host_guard_test.py"],
    { cwd: new URL("../", import.meta.url) },
  );
  expect(result.stderr).toContain("Ran 6 tests");
  expect(result.stderr).toMatch(/\bOK\b/);
});
