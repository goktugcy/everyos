import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it, expect } from "vitest";
const exec = promisify(execFile);

it("packages runtime files only and rejects incomplete or linked builds", async () => {
  const script = `
import sys, tempfile
from pathlib import Path
sys.path.insert(0, 'scripts')
from package_inputs import runtime_files, REQUIRED
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    for name in REQUIRED:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('runtime fixture')
    for name in ('sdk/cli.tgz', 'official-apps/index.json', 'sdk-acceptance.json', 'packages/old.deb'):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('excluded fixture')
    assert {p.relative_to(root).as_posix() for p in runtime_files(root)} == set(REQUIRED)
    (root / 'web/leak').symlink_to(root / 'sdk/cli.tgz')
    try:
        runtime_files(root)
        raise AssertionError('symlink accepted')
    except ValueError:
        pass
    (root / 'web/leak').unlink()
    (root / REQUIRED[0]).unlink()
    try:
        runtime_files(root)
        raise AssertionError('incomplete build accepted')
    except ValueError:
        pass
print('runtime-only packaging passed')
`;
  const result = await exec("python3", ["-c", script], { cwd: new URL("../", import.meta.url) });
  expect(result.stdout.trim()).toBe("runtime-only packaging passed");
});
