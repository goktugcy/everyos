#!/usr/bin/env python3
"""Real package upgrade and SDK lifecycle, exclusively in our disposable qualification VM."""
import argparse
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

ROOT = Path('/srv/everyos-sdk-qualification')
DATA = Path('/var/lib/everyos')
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
csrf = ''
records = []


def command(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)


def request(path, body=None, token=None, method=None):
    headers = {'content-type': 'application/json', 'origin': 'http://127.0.0.1:7470', 'x-everyos-csrf': csrf}
    if token:
        headers['x-everyos-app-instance'] = token
    req = urllib.request.Request('http://127.0.0.1:7470/api' + path,
                                 data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with opener.open(req, timeout=130) as response:
            data = response.read()
            return json.loads(data) if data else None
    except urllib.error.HTTPError as error:
        detail = json.loads(error.read()).get('error', {})
        print('API failure: '+path+' '+str(error.code)+' '+str(detail.get('code')), flush=True)
        raise


def wait(predicate, timeout=240):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = predicate()
            if value:
                return value
        except (OSError, ValueError, urllib.error.URLError, sqlite3.Error):
            pass
        time.sleep(0.2)
    raise AssertionError('Qualification condition timed out')


def record(name, details=None):
    records.append({'scenario': name, 'passed': True, 'details': details})
    print(name + ': passed', flush=True)


def main():
    global csrf
    parser = argparse.ArgumentParser()
    parser.add_argument('--disposable-host', required=True, action='store_true')
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--resume', action='store_true', help='Reuse only this disposable run after a harness failure')
    args = parser.parse_args()
    if os.geteuid() != 0 or socket.gethostname() != 'lima-everyos-sdk-qual-20261025':
        parser.error('Only the dedicated disposable qualification VM is accepted')
    assert command('everyos', 'version').stdout.strip() == '0.1.36'
    credential_file = ROOT/'credentials.json'
    if args.resume:
        credentials = json.loads(credential_file.read_text())
        session = request('/auth/login', credentials)['session']
    else:
        assert request('/bootstrap')['setupRequired']
        credentials = {'username': 'sdk-qualification', 'password': 'Qualification-' + secrets.token_urlsafe(24)}
        credential_file.write_text(json.dumps(credentials))
        credential_file.chmod(0o600)
        session = request('/setup', {**credentials, 'setupToken': (DATA/'setup-token').read_text().strip(), 'displayName': 'Disposable qualification', 'locale': 'en'})
    csrf = session['csrfToken']
    account = session['user']['id']
    # Exercise the real Linux account/PAM/sudo boundary, as a normal administrator must do.
    import pwd
    try:
        pwd.getpwnam('sdk-qualification')
    except KeyError:
        command('useradd', '--create-home', '--shell', '/bin/bash', '--groups', 'sudo', 'sdk-qualification')
    command('chpasswd', input='sdk-qualification:'+credentials['password']+'\n')
    request('/users/'+account+'/linux-account', {'account': 'sdk-qualification', 'currentPassword': credentials['password'], 'linuxPassword': credentials['password']}, method='PUT')
    request('/account/linux/unlock', {'linuxPassword': credentials['password']})
    home = DATA/'homes'/account/'Desktop'
    home.mkdir(parents=True, exist_ok=True)
    sentinel = home/'qualification.txt'
    sentinel.write_text('Persistent account home across the real package upgrade.\n')
    for path in (home.parent.parent, home.parent, home, sentinel):
        os.chown(path, DATA.stat().st_uid, DATA.stat().st_gid)
    config = Path('/etc/everyos/config.yaml')
    config.write_text(config.read_text() + '\n# Disposable owner configuration preservation check.\n')
    original = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in
                (sentinel, config, DATA/'secret.key', Path('/etc/everyos/agent.key'))}
    record('published-0.1.36-install-and-account-home', {'architecture': command('dpkg', '--print-architecture').stdout.strip()})

    # The published baseline was verified with its real key by install-prior.py. The unreleased
    # candidate uses an explicitly ephemeral trust root; production private keys are never used.
    source = ROOT/'releases'
    version = source/'download/v0.1.37'
    version.mkdir(parents=True, exist_ok=True)
    for name in ('release.json', 'everyos_0.1.37_arm64.deb'):
        (version/name).write_bytes((args.candidate/name).read_bytes())
    (source/'latest/download/release.json').write_bytes((version/'release.json').read_bytes())
    # Keep the actual old package bytes available for rollback under the same test trust root.
    baseline_metadata = (args.candidate/'signed-prior.json').read_bytes()
    (source/'download/v0.1.36/release.json').write_bytes(baseline_metadata)
    Path('/var/lib/everyos-updates/packages/0.1.36/release.json').write_bytes(baseline_metadata)
    release_config = Path('/etc/everyos/release.json')
    release_config.write_text(json.dumps({'source': source.as_uri(), 'publicKey': (args.candidate/'everyos-release-public.pem').read_text(), 'redirectHosts': []}))
    release_config.chmod(0o600)
    command('systemctl', 'restart', 'everyos-api', 'everyos-update')
    wait(lambda: request('/health')['status'] == 'ok')
    available = request('/self-update/check', {})
    assert available['available']['version'] == '0.1.37'
    prepared = request('/self-update/prepare', {})
    def backed_up():
        view = request('/backups/job')
        backup_job = view['job'] or view['lastJob']
        return backup_job if backup_job and backup_job['id'] == prepared['id'] and backup_job['status'] != 'running' else None
    prepared = wait(backed_up)
    assert prepared['status'] == 'succeeded'
    job = request('/self-update/install', {'version': '0.1.37', 'backupId': prepared['backupId'], 'password': credentials['password'], 'confirm': True})
    assert job['id']
    def completed():
        current = json.loads(Path('/var/lib/everyos-updates/job.json').read_text())['job']
        return current if current['id'] == job['id'] and current['finishedAt'] is not None else None
    finished = wait(completed, 300)
    assert finished['state'] == 'succeeded', finished.get('error')
    wait(lambda: request('/bootstrap')['version'] == '0.1.37')
    assert command('everyos', 'version').stdout.strip() == '0.1.37'
    for name, digest in original.items():
        assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest
    assert request('/auth/login', credentials)['status'] == 'authenticated'
    record('authenticated-0.1.36-to-0.1.37-update-preserves-account-home-config-and-keys', {'candidateTrust': 'ephemeral-test-key', 'jobState': finished['state']})

    fixtures = ROOT/'app-fixtures'
    fixtures.mkdir(exist_ok=True)
    import shutil
    shutil.copytree(args.fixtures, fixtures, dirs_exist_ok=True)
    (fixtures/'registry/index.json').write_bytes((fixtures/'index-1.0.0.json').read_bytes())
    identity = json.loads((fixtures/'identity.json').read_text())
    config.write_text(config.read_text() + '\ndesktopApps:\n  officialRegistry:\n    url: http://127.0.0.1:8931/index.json\n    allowPrivate: true\n    publicKey: |\n' + ''.join('      ' + line + '\n' for line in identity['publicKey'].splitlines()))
    command('systemd-run', '--unit=everyos-sdk-fixture', '--property=WorkingDirectory='+str(fixtures/'registry'), '/usr/bin/python3', '-m', 'http.server', '8931', '--bind', '127.0.0.1')
    started = time.monotonic()
    command('systemctl', 'restart', 'everyos-api', 'everyos-agent')
    wait(lambda: request('/health')['status'] == 'ok')
    startup = round((time.monotonic() - started) * 1000, 2)
    session = request('/auth/login', credentials)['session']
    csrf = session['csrfToken']
    assert request('/account/linux')['account']['name'] == 'sdk-qualification'
    request('/account/linux/unlock', {'linuxPassword': credentials['password']})
    request('/desktop-apps/registries/official/sync', {})
    app_id = 'com.example.qualification'
    installed = request('/desktop-apps/installed', {'appId': app_id, 'registryId': 'official', 'approve': []})
    assert installed['version'] == '1.0.0'
    token = request('/app-sdk/instances', {'appId': app_id, 'kind': 'window'})['token']
    value = {'text': 'SDK data persists in the packaged Linux runtime', 'revision': 1}
    request('/app-sdk/storage/set', {'key': 'qualification', 'value': value}, token)
    (fixtures/'registry/index.json').write_bytes((fixtures/'index-1.0.1.json').read_bytes())
    request('/desktop-apps/registries/official/sync', {})
    updated = request('/desktop-apps/installed/'+app_id+'/update', {'approve': []})
    assert updated['version'] == '1.0.1' and updated['runtimeUrl'] != installed['runtimeUrl']
    token = request('/app-sdk/instances', {'appId': app_id, 'kind': 'window'})['token']
    assert request('/app-sdk/storage/get', {'key': 'qualification'}, token)['entry']['value'] == value
    record('packaged-sdk-install-update-and-app-storage-persistence')
    backup = json.loads(command('everyos', 'backup', '--credentials-stdin', input=json.dumps(credentials), timeout=240).stdout)
    assert backup['status'] == 'succeeded'
    view = request('/backups/'+backup['backupId'])
    assert view['verification']['ok'] and view['contents']['homes']
    record('verified-backup-with-installed-sdk-app-and-account-home')
    request('/app-sdk/storage/set', {'key': 'qualification', 'value': {'text': 'Changed after backup'}}, token)
    sentinel.write_text('Changed after backup\n')
    previous_pid = command('systemctl', 'show', 'everyos-api', '--property=MainPID', '--value').stdout.strip()
    restored = json.loads(command('everyos', 'restore', backup['backupId'], '--confirm', '--credentials-stdin', input=json.dumps(credentials), timeout=240).stdout)
    assert restored['status'] == 'succeeded' and restored['restart'] == 'automatic'
    wait(lambda: command('systemctl', 'show', 'everyos-api', '--property=MainPID', '--value').stdout.strip() not in ('0', previous_pid))
    wait(lambda: request('/health')['status'] == 'ok')
    assert hashlib.sha256(sentinel.read_bytes()).hexdigest() == original[str(sentinel)]
    session = request('/auth/login', credentials)['session']
    csrf = session['csrfToken']
    request('/account/linux/unlock', {'linuxPassword': credentials['password']})
    token = request('/app-sdk/instances', {'appId': app_id, 'kind': 'window'})['token']
    assert request('/app-sdk/storage/get', {'key': 'qualification'}, token)['entry']['value'] == value
    record('authenticated-cli-restore-recovers-sdk-data-home-and-restarts-supervised-api')
    (fixtures/'registry/index.json').write_bytes((fixtures/'index-revoked.json').read_bytes())
    request('/desktop-apps/registries/official/sync', {})
    apps = request('/desktop-apps/installed')['apps']
    assert next(app for app in apps if app['appId'] == app_id)['state'] == 'revoked'
    try:
        request('/app-sdk/instances', {'appId': app_id, 'kind': 'window'})
        raise AssertionError('Revoked app still launches')
    except urllib.error.HTTPError as error:
        assert error.code == 404
    record('packaged-sdk-revocation-blocks-launch')
    units = {}
    ticks = os.sysconf('SC_CLK_TCK')
    def counters(pid):
        fields = Path(f'/proc/{pid}/stat').read_text().split(') ', 1)[1].split()
        return (int(fields[11]) + int(fields[12])) / ticks
    for unit in ('everyos-api', 'everyos-agent'):
        pid = int(command('systemctl', 'show', unit, '--property=MainPID', '--value').stdout.strip())
        rss = next(line.split()[1] for line in Path(f'/proc/{pid}/status').read_text().splitlines() if line.startswith('VmRSS:'))
        units[unit] = {'pid': pid, 'rssKiB': int(rss), 'startCpuSeconds': counters(pid)}
    begin = time.monotonic()
    time.sleep(5)
    for metrics in units.values():
        metrics['idleCpuPercent'] = round(100 * (counters(metrics['pid']) - metrics.pop('startCpuSeconds')) / (time.monotonic() - begin), 3)
        del metrics['pid']
    inputs = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in {'priorPackage': source/'download/v0.1.36/everyos_0.1.36_arm64.deb', 'candidatePackage': args.candidate/'everyos_0.1.37_arm64.deb'}.items()}
    report = {'format': 'everyos-sdk-linux-qualification/1', 'status': 'passed', 'fromVersion': '0.1.36', 'toVersion': '0.1.37', 'inputs': inputs, 'platform': {'os': 'Ubuntu 24.04', 'architecture': 'arm64', 'environment': 'disposable Lima VZ VM', 'physicalPi': False}, 'productionCommunityTested': False, 'startupToHealthyMs': startup, 'idleSampleSeconds': 5, 'services': units, 'scenarios': records}
    (ROOT/'qualification.json').write_text(json.dumps(report, indent=2)+'\n')
    print('Linux qualification report saved', flush=True)


if __name__ == '__main__':
    main()
