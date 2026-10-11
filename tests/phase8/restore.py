#!/usr/bin/env python3
"""Verify an authenticated CLI restore and the real systemd API restart in the fixture VM."""
import json
import os
from pathlib import Path
import socket
import acceptance as host

assert os.geteuid() == 0 and socket.gethostname().startswith("lima-everyos-phase8")
host.wait(lambda: host.request("/health")["status"] == "ok")
host.credentials = json.loads(Path("/root/everyos-credentials.json").read_text())
session = host.request("/auth/login", host.credentials)["session"]
host.csrf = session["csrfToken"]
home = host.DATA / "homes" / session["user"]["id"] / "Desktop/phase8.txt"
original = home.read_bytes()
backup = json.loads(host.command("everyos", "backup", "--credentials-stdin", input=json.dumps(host.credentials)).stdout)
assert backup["status"] == "succeeded"
home.write_bytes(b"Changed after the backup\n")
previous_pid = host.command("systemctl", "show", "everyos-api.service", "--property=MainPID", "--value").stdout.strip()
result = json.loads(host.command("everyos", "restore", backup["backupId"], "--confirm", "--credentials-stdin", input=json.dumps(host.credentials)).stdout)
assert result["status"] == "succeeded" and result["restart"] == "automatic"
host.wait(lambda: host.command("systemctl", "show", "everyos-api.service", "--property=MainPID", "--value").stdout.strip() not in [previous_pid, "0"])
host.wait(lambda: host.request("/health")["status"] == "ok")
assert home.read_bytes() == original
assert host.request("/auth/login", host.credentials)["status"] == "authenticated"
path = Path("/root/phase8-acceptance.json")
record = json.loads(path.read_text())
record["scenarios"].append({"scenario": "authenticated-cli-restore-preserves-homes-and-restarts-supervised-api", "passed": True})
audit_path = host.STATE / "audit.jsonl"
audit_text = audit_path.read_text()
events = [json.loads(line) for line in audit_text.splitlines()]
assert audit_path.stat().st_uid == 0 and audit_path.stat().st_mode & 0o777 == 0o600
assert host.credentials["password"] not in audit_text
assert any(event["state"] == "succeeded" for event in events)
assert sum(event["state"] == "rolled-back" for event in events) >= 2
record["scenarios"].append({"scenario": "private-root-update-audit-survives-database-rollback-purge-and-cli-restore", "passed": True})
path.write_text(json.dumps(record, indent=2) + "\n")
print("authenticated-cli-restore-preserves-homes-and-restarts-supervised-api: passed")
print("private-root-update-audit-survives-database-rollback-purge-and-cli-restore: passed")
