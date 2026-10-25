#!/usr/bin/env python3
"""Prepare only a fresh hosted runner; never adopt an existing EveryOS installation."""
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
from host_guard import ci_identity, MARKER, require_disposable_host

if os.geteuid() != 0 or not Path('/run/systemd/system').is_dir():
    raise SystemExit('A disposable Linux systemd CI VM is required')
identity = ci_identity()
for name in ('/etc/everyos', '/var/lib/everyos', '/var/lib/everyos-agent',
             '/var/lib/everyos-updates', '/srv/everyos-sdk-qualification', '/home/sdk-qualification'):
    if Path(name).exists() or Path(name).is_symlink():
        raise SystemExit('Refusing to adopt existing EveryOS state')
try:
    pwd.getpwnam('sdk-qualification')
except KeyError:
    pass
else:
    raise SystemExit('Refusing to adopt an existing Linux fixture account')
installed = subprocess.run(['dpkg-query', '-W', '-f=${Status}', 'everyos'], capture_output=True, text=True)
if installed.returncode == 0:
    raise SystemExit('EveryOS already has package-manager state')
with socket.socket() as probe:
    probe.bind(('0.0.0.0', 7470))
old_mask = os.umask(0o077)
try:
    with MARKER.open('x') as handle:
        json.dump(identity, handle)
finally:
    os.umask(old_mask)
require_disposable_host()
print('Fresh hosted qualification VM prepared')
