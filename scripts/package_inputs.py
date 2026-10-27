"""Select only runtime build outputs for the host package."""
from pathlib import Path

REQUIRED = ("api/server.mjs", "agent/agent.mjs", "agent/account-worker.mjs",
            "agent/sudo-witness.mjs", "cli/cli.mjs", "update/worker.mjs", "web/index.html")


def runtime_files(dist: Path):
    for name in REQUIRED:
        if not (dist / name).is_file():
            raise ValueError(f"Missing runtime build output: {name}")
    files = []
    for name in ("api", "agent", "cli", "update", "web"):
        directory = dist / name
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError("Runtime build directories must be real directories")
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError("Build output may not contain symlinks")
            if path.is_file():
                files.append(path)
            elif not path.is_dir():
                raise ValueError("Build output must contain only regular files")
    return files
