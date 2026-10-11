#!/usr/bin/env python3
"""Create signed good/broken package fixtures from the real production archives."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

def ar_members(data):
    assert data.startswith(b"!<arch>\n")
    offset = 8
    while offset < len(data):
        header = data[offset:offset + 60]
        size = int(header[48:58])
        yield header[:16].decode().strip().rstrip("/"), data[offset + 60:offset + 60 + size]
        offset += 60 + size + size % 2

def repack(path, version):
    members = []
    for name, data in ar_members(path.read_bytes()):
        if name.endswith(".tar.gz"):
            output = io.BytesIO()
            with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data))) as source, tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as target:
                for member in source.getmembers():
                    contents = source.extractfile(member).read() if member.isfile() else b""
                    if member.name == "control":
                        contents = contents.replace(b"Version: 0.1.0\n", f"Version: {version}\n".encode())
                    if member.name == "usr/lib/everyos/VERSION":
                        contents = (version + "\n").encode()
                    if version == "0.1.2" and member.name == "usr/lib/everyos/api/server.mjs":
                        contents = b'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync("/var/lib/everyos/everyos.db"); db.exec("CREATE TABLE acceptance_failed_migration (id INTEGER); INSERT INTO schema_migrations(version,name,applied_at) VALUES(11, \'acceptance failure\', 1)"); db.close(); process.exit(88);\n'
                    if version == "0.1.3" and member.name == "preinst":
                        contents += b'\nif [ "${EVERYOS_PACKAGE_TRANSACTION:-0}" = 1 ]; then exit 95; fi\n'
                    if member.isfile():
                        member.size = len(contents)
                    target.addfile(member, io.BytesIO(contents) if member.isfile() else None)
            data = gzip.compress(output.getvalue(), compresslevel=9, mtime=0)
        members.append((name, data))
    output = io.BytesIO()
    output.write(b"!<arch>\n")
    for name, data in members:
        output.write(f"{name+'/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n".encode())
        output.write(data)
        if len(data) % 2:
            output.write(b"\n")
    return output.getvalue()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--packages", type=Path, default=Path("dist/packages"))
    parser.add_argument("--output", type=Path, default=Path(".dev/phase8/source"))
    parser.add_argument("--vm-arch", choices=["arm64", "amd64"], default="arm64")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    key = args.output.parent / "fixture-private.pem"
    public = args.output.parent / "fixture-public.pem"
    if not key.exists():
        subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(key)], check=True, capture_output=True)
    key.chmod(0o600)
    subprocess.run(["openssl", "pkey", "-in", str(key), "-pubout", "-out", str(public)], check=True, capture_output=True)
    for version in ["0.1.0", "0.1.1", "0.1.2", "0.1.3"]:
        directory = args.output / f"download/v{version}"
        directory.mkdir(parents=True, exist_ok=True)
        artifacts = {}
        for arch in ["arm64", "amd64"]:
            original = args.packages / f"everyos_0.1.0_{arch}.deb"
            data = original.read_bytes() if version == "0.1.0" else repack(original, version)
            filename = f"everyos_{version}_{arch}.deb"
            artifacts[arch] = {"file": filename, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            # Both architectures are built and hashed; only the selected VM's artifacts are retained.
            if arch == args.vm_arch:
                (directory / filename).write_bytes(data)
        now = int(time.time() * 1000)
        payload = json.dumps({"format": "everyos-release", "version": version, "minVersion": "0.1.0", "schemaVersion": 11 if version == "0.1.2" else 10, "publishedAt": now, "expiresAt": now + 86400000, "notes": "Disposable acceptance fixture", "artifacts": artifacts}, separators=(",", ":")).encode()
        temporary = args.output.parent / "fixture-payload"
        temporary.write_bytes(payload)
        signature = subprocess.check_output(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(temporary)])
        temporary.unlink()
        (directory / "release.json").write_text(json.dumps({"payload": base64.b64encode(payload).decode(), "signature": base64.b64encode(signature).decode()}))
        print(f"Prepared signed {version} fixture for {args.vm_arch}", flush=True)
    latest = args.output / "latest/download"
    latest.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.output / "download/v0.1.0/release.json", latest / "release.json")

if __name__ == "__main__":
    main()
