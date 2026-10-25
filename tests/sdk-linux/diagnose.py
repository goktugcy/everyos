"""Expose bounded service/error codes from a failed fixture without logging credentials."""
import json
import subprocess
from host_guard import require_disposable_host

require_disposable_host()
for unit in ('everyos-api', 'everyos-agent', 'everyos-update'):
    state = subprocess.run(['systemctl', 'show', unit, '--property=ActiveState,SubState,MainPID'], capture_output=True, text=True)
    print(json.dumps({'unit': unit, 'state': state.stdout.strip()}))
    logs = subprocess.run(['journalctl', '-u', unit, '-n', '80', '--no-pager', '-o', 'cat'], capture_output=True, text=True)
    for line in logs.stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get('level') not in ('warn', 'error'):
            continue
        safe = {key: event[key] for key in ('level', 'msg', 'op', 'code') if key in event}
        if event.get('message') in ('LINUX_ACCOUNT_REQUIRED', 'LINUX_AUTH_FAILED', 'LINUX_SUDO_REQUIRED', 'LINUX_AUTH_RATE_LIMITED', 'LINUX_FILE_DENIED'):
            safe['reason'] = event['message']
        print(json.dumps({'unit': unit, **safe})[:1000])
