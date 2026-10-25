#!/usr/bin/env python3
"""Build portable Debian archives without requiring dpkg on the build host."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tarfile
import urllib.request
from package_inputs import runtime_files

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--arch", choices=["arm64", "amd64"], required=True)
parser.add_argument("--version", default=json.loads((ROOT / "package.json").read_text())["version"])
parser.add_argument("--output", type=Path, default=ROOT / "dist/packages")
parser.add_argument("--dist", type=Path, default=ROOT / "dist")
args = parser.parse_args()
if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", args.version):
    parser.error("version must be a stable semantic version")
pin = json.loads((ROOT / "packaging/node-runtime.json").read_text())
node_arch = "arm64" if args.arch == "arm64" else "x64"
prefix = f"node-v{pin['version']}-linux-{node_arch}"
cache = ROOT / ".dev/phase8" / f"{prefix}.tar.xz"
cache.parent.mkdir(parents=True, exist_ok=True)
if not cache.exists():
    with urllib.request.urlopen(f"https://nodejs.org/dist/v{pin['version']}/{prefix}.tar.xz", timeout=60) as response:
        data = response.read(100 * 1024 * 1024 + 1)
    if len(data) > 100 * 1024 * 1024:
        raise ValueError("Node runtime is too large")
    cache.write_bytes(data)
if hashlib.sha256(cache.read_bytes()).hexdigest() != pin[args.arch]:
    raise ValueError("Node runtime checksum mismatch")
epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "0"))

def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w", format=tarfile.PAX_FORMAT) as tar:
        directories = sorted({parent.as_posix() for name, _, _ in entries for parent in Path(name).parents if parent.as_posix() != "."}, key=lambda value: (value.count("/"), value))
        for name in directories:
            entry = tarfile.TarInfo(name + "/")
            entry.type, entry.mode, entry.mtime = tarfile.DIRTYPE, 0o755, epoch
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = "root"
            tar.addfile(entry)
        for name, data, mode in entries:
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.mtime = len(data), mode, epoch
            entry.uid = entry.gid = 0
            entry.uname = entry.gname = "root"
            tar.addfile(entry, io.BytesIO(data))
    return gzip.compress(stream.getvalue(), compresslevel=9, mtime=0)

entries = []
with tarfile.open(cache, "r:xz") as node:
    for source, target, mode in [("bin/node", "usr/lib/everyos/node/bin/node", 0o755), ("LICENSE", "usr/share/doc/everyos/Node-LICENSE", 0o644)]:
        handle = node.extractfile(f"{prefix}/{source}")
        if handle is None:
            raise ValueError("Invalid Node runtime archive")
        entries.append((target, handle.read(), mode))
for path in runtime_files(args.dist):
    relative = path.relative_to(args.dist)
    entries.append((f"usr/lib/everyos/{relative.as_posix()}", path.read_bytes(), 0o644))
entries = [entry for entry in entries if entry[0] != "usr/lib/everyos/VERSION"]
entries.append(("usr/lib/everyos/VERSION", (args.version + "\n").encode(), 0o644))
for path in sorted((ROOT / "packaging/systemd").iterdir()):
    entries.append((f"usr/lib/systemd/system/{path.name}", path.read_bytes(), 0o644))
for name, target, mode in [("config.yaml", "etc/everyos/config.yaml", 0o640), ("agent.yaml", "etc/everyos/agent.yaml", 0o600), ("everyos", "usr/bin/everyos", 0o755), ("pam-everyos", "etc/pam.d/everyos", 0o644)]:
    entries.append((target, (ROOT / "packaging" / name).read_bytes(), mode))
for name in ["README.md", "LICENSE"]:
    if (ROOT / name).exists():
        entries.append((f"usr/share/doc/everyos/{name}", (ROOT / name).read_bytes(), 0o644))
control = f"""Package: everyos
Version: {args.version}
Architecture: {args.arch}
Maintainer: EveryOS contributors <noreply@everyos.invalid>
Section: admin
Priority: optional
Depends: libc6 (>= 2.34), libstdc++6, libatomic1, ca-certificates, systemd (>= 248), adduser, openssl, python3, iproute2, libpam0g, libpam-modules, libpam-runtime, sudo
Installed-Size: {sum(len(data) for _, data, _ in entries) // 1024}
Description: Self-hosted EveryOS personal OS and Linux management service
 Unprivileged API, typed local agent, web desktop and verified update worker.
"""
controls = [("control", control.encode(), 0o644), ("conffiles", b"/etc/everyos/config.yaml\n/etc/everyos/agent.yaml\n/etc/pam.d/everyos\n", 0o644)]
controls += [(name, (ROOT / "packaging/debian" / name).read_bytes(), 0o755) for name in ["preinst", "postinst", "prerm", "postrm"]]
args.output.mkdir(parents=True, exist_ok=True)
output = args.output / f"everyos_{args.version}_{args.arch}.deb"
with output.open("wb") as deb:
    deb.write(b"!<arch>\n")
    for name, data in [("debian-binary", b"2.0\n"), ("control.tar.gz", archive(controls)), ("data.tar.gz", archive(entries))]:
        header = f"{name + '/':<16}{epoch:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n"
        deb.write(header.encode("ascii"))
        deb.write(data)
        if len(data) % 2:
            deb.write(b"\n")
print(f"Built {output.name}: {output.stat().st_size} bytes")
