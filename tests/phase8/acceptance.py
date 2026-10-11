#!/usr/bin/env python3
"""Destructive acceptance ONLY inside a newly created disposable Linux VM."""
import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

SOURCE = Path("/srv/everyos-releases")
STATE = Path("/var/lib/everyos-updates")
DATA = Path("/var/lib/everyos")
records = []
credentials = {"username": "phase8-admin", "password": "Acceptance-" + secrets.token_urlsafe(24)}
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
csrf = ""

def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request("http://127.0.0.1:7470/api" + path, data=data, headers={"content-type": "application/json", "origin": "http://127.0.0.1:7470", "x-everyos-csrf": csrf})
    with opener.open(req, timeout=130) as response:
        return json.load(response)

def command(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)

def wait(predicate, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (OSError, ValueError, urllib.error.URLError, sqlite3.Error):
            pass
        time.sleep(0.2)
    raise AssertionError("Acceptance condition timed out")

def record(name, details=None):
    records.append({"scenario": name, "passed": True, **({"details": details} if details else {})})
    print(name + ": passed", flush=True)

def select(version):
    (SOURCE / "latest/download/release.json").write_bytes((SOURCE / f"download/v{version}/release.json").read_bytes())

def safety():
    initial = request("/self-update/prepare", {})
    def done():
        jobs = request("/backups/job")
        job = jobs["job"] or jobs["lastJob"]
        return job if job and job["id"] == initial["id"] and job["status"] != "running" else None
    job = wait(done)
    assert job["status"] == "succeeded"
    view = request("/backups/" + job["backupId"])
    assert view["verification"]["ok"] and view["contents"]["homes"]
    return job["backupId"]

def start(version):
    request("/self-update/check", {})
    return request("/self-update/install", {"version": version, "backupId": safety(), "password": credentials["password"], "confirm": True})

def outcome(job_id):
    def done():
        job = json.loads((STATE / "job.json").read_text())["job"]
        return job if job["id"] == job_id and job["finishedAt"] is not None else None
    return wait(done, 300)

def main():
    global csrf, credentials
    parser = argparse.ArgumentParser()
    parser.add_argument("--disposable-host", action="store_true", required=True)
    parser.add_argument("--output", type=Path, default=Path("/root/phase8-acceptance.json"))
    args = parser.parse_args()
    if os.geteuid() != 0 or not socket.gethostname().startswith("lima-everyos-phase8"):
        parser.error("Only a fresh dedicated lima-everyos-phase8 VM is accepted")
    wait(lambda: request("/health")["status"] == "ok")
    assert request("/bootstrap")["version"] == "0.1.0"
    assert command("everyos", "version").stdout.strip() == "0.1.0"
    assert json.loads(command("everyos", "status").stdout)["status"] == "ok"
    doctor = json.loads(command("everyos", "doctor").stdout)
    assert doctor["releaseConfigured"] and doctor["health"]["status"] == "ok"
    record("verified-install-and-cli", {"architecture": command("dpkg", "--print-architecture").stdout.strip(), "runtime": doctor["node"]})
    if request("/bootstrap")["setupRequired"]:
        session = request("/setup", {"setupToken": (DATA / "setup-token").read_text().strip(), **credentials, "displayName": "Acceptance administrator", "locale": "en"})
    else:
        credentials = json.loads(Path("/root/everyos-credentials.json").read_text())
        session = request("/auth/login", credentials)["session"]
    csrf = session["csrfToken"]
    home = DATA / "homes" / session["user"]["id"] / "Desktop"
    home.mkdir(parents=True, exist_ok=True)
    sentinel = home / "phase8.txt"
    sentinel.write_text("Persistent EveryOS home acceptance\n")
    uid = os.stat(DATA).st_uid
    for path in [home.parent.parent, home.parent, home, sentinel]:
        os.chown(path, uid, os.stat(DATA).st_gid)
    original_home = sentinel.read_bytes()
    key_hash = hashlib.sha256((DATA / "secret.key").read_bytes()).hexdigest()
    agent_key_hash = hashlib.sha256(Path("/etc/everyos/agent.key").read_bytes()).hexdigest()
    config = Path("/etc/everyos/config.yaml")
    config.write_text(config.read_text() + "\n# Owner configuration must survive upgrades.\n")
    original_config = config.read_bytes()
    credentials_file = Path("/root/everyos-credentials.json")
    credentials_file.write_text(json.dumps(credentials))
    credentials_file.chmod(0o600)
    backup = json.loads(command("everyos", "backup", "--credentials-stdin", input=json.dumps(credentials)).stdout)
    assert backup["status"] == "succeeded"
    record("authenticated-cli-backup-with-account-home")
    select("0.1.1")
    metadata = SOURCE / "latest/download/release.json"
    original = metadata.read_bytes()
    envelope = json.loads(original)
    envelope["signature"] = base64.b64encode(bytes(64)).decode()
    metadata.write_text(json.dumps(envelope))
    try:
        request("/self-update/check", {})
        raise AssertionError("Invalid signature accepted")
    except urllib.error.HTTPError:
        pass
    metadata.write_bytes(original)
    assert request("/health")["status"] == "ok"
    record("invalid-signature-rejected-before-downtime")
    architecture = command("dpkg", "--print-architecture").stdout.strip()
    package = SOURCE / f"download/v0.1.1/everyos_0.1.1_{architecture}.deb"
    full = package.read_bytes()
    package.write_bytes(full[:4096])
    failed = outcome(start("0.1.1")["id"])
    assert failed["state"] == "failed" and failed["error"] == "package-verification-failed"
    package.write_bytes(full)
    assert request("/health")["status"] == "ok"
    record("truncated-download-rejected-with-services-running")
    process = subprocess.Popen(["everyos", "update", "--apply", "--confirm", "--credentials-stdin"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert process.stdin is not None
    process.stdin.write(json.dumps(credentials))
    process.stdin.close()
    def installing():
        job = json.loads((STATE / "job.json").read_text())["job"]
        return job if job["state"] == "installing" else None
    job = wait(installing)
    worker_pid = command("systemctl", "show", "everyos-update.service", "--property=MainPID", "--value").stdout.strip()
    command("systemctl", "stop", "everyos-api.service", "everyos-agent.service")
    assert command("systemctl", "show", "everyos-update.service", "--property=MainPID", "--value").stdout.strip() == worker_pid
    result = outcome(job["id"])
    assert result["state"] == "succeeded", result["error"]
    assert process.stdout is not None
    cli_result = json.loads(process.stdout.read())
    assert cli_result["job"]["state"] == "succeeded"
    assert process.wait(timeout=10) == 0
    assert request("/bootstrap")["version"] == "0.1.1"
    assert sentinel.read_bytes() == original_home and config.read_bytes() == original_config
    assert hashlib.sha256((DATA / "secret.key").read_bytes()).hexdigest() == key_hash
    assert hashlib.sha256(Path("/etc/everyos/agent.key").read_bytes()).hexdigest() == agent_key_hash
    record("cli-upgrade-survives-api-agent-stop-preserves-config-keys-homes")
    select("0.1.2")
    job = start("0.1.2")
    wait(lambda: json.loads((STATE / "job.json").read_text())["job"]["state"] == "restarting")
    def migrated():
        with sqlite3.connect(DATA / "everyos.db") as database:
            return database.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 11
    wait(migrated)
    command("systemctl", "kill", "--kill-whom=main", "--signal=SIGKILL", "everyos-update.service")
    result = outcome(job["id"])
    assert result["state"] == "rolled-back", result["error"]
    wait(lambda: request("/health")["status"] == "ok")
    assert request("/bootstrap")["version"] == "0.1.1"
    with sqlite3.connect(DATA / "everyos.db") as database:
        assert database.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 10
        assert database.execute("SELECT COUNT(*) FROM sqlite_schema WHERE name='acceptance_failed_migration'").fetchone()[0] == 0
    assert sentinel.read_bytes() == original_home
    record("killed-worker-resumes-package-and-migrated-database-recovery")
    select("0.1.3")
    result = outcome(start("0.1.3")["id"])
    assert result["state"] == "rolled-back" and result["error"] == "dpkg-install-failed"
    wait(lambda: request("/health")["status"] == "ok")
    assert command("everyos", "version").stdout.strip() == "0.1.1"
    record("dpkg-install-failure-recovers-prior-package-and-database")
    info = command("findmnt", "--noheadings", "--output=FSTYPE,OPTIONS", "/run/everyos/app-configs").stdout
    assert "tmpfs" in info and all(flag in info for flag in ["nodev", "nosuid", "noexec"])
    properties = command("systemctl", "show", "everyos-api.service", "--property=User,NoNewPrivileges,ProtectSystem,CapabilityBoundingSet").stdout
    assert "User=everyos" in properties and "NoNewPrivileges=yes" in properties and "ProtectSystem=strict" in properties and "CapabilityBoundingSet=\n" in properties
    record("unprivileged-api-hardening-and-host-visible-private-tmpfs")
    command("dpkg", "--purge", "everyos")
    assert sentinel.read_bytes() == original_home
    assert (DATA / "everyos.db").is_file() and (DATA / "secret.key").is_file()
    assert Path("/etc/everyos/agent.key").is_file() and (STATE / "packages/0.1.1").is_dir()
    assert not Path("/usr/lib/everyos/api/server.mjs").exists()
    record("purge-retains-data-homes-keys-backups-and-recovery-artifacts")
    args.output.write_text(json.dumps({"platform": Path("/etc/os-release").read_text(), "architecture": architecture, "source": "signed offline fixtures with an ephemeral test key", "scenarios": records}, indent=2) + "\n")

if __name__ == "__main__":
    main()
