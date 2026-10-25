"""Limit package qualification to our disposable VM or an explicitly prepared hosted CI VM."""
import json
import os
from os import lstat
from pathlib import Path
import re
import socket
import stat

MARKER = Path('/run/everyos-sdk-qualification.json')


def ci_identity():
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or
            os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or
            os.environ.get('GITHUB_REPOSITORY', '').lower() != 'goktugcy/everyos' or
            not re.fullmatch(r'\d+', os.environ.get('GITHUB_RUN_ID', '')) or
            not re.fullmatch(r'[a-f0-9]{40}', os.environ.get('GITHUB_SHA', ''))):
        raise RuntimeError('An ephemeral GitHub-hosted EveryOS runner is required')
    return {'repository': os.environ['GITHUB_REPOSITORY'],
            'runId': os.environ['GITHUB_RUN_ID'], 'commit': os.environ['GITHUB_SHA']}


def require_disposable_host():
    if os.geteuid() != 0:
        raise RuntimeError('Qualification requires root inside a disposable test host')
    if socket.gethostname() == 'lima-everyos-sdk-qual-20261025':
        return 'disposable Lima VZ VM'
    identity = ci_identity()
    info = lstat(MARKER)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or
            MARKER.resolve() != MARKER or json.loads(MARKER.read_text()) != identity):
        raise RuntimeError('The fresh CI qualification marker is absent or untrusted')
    return 'disposable GitHub-hosted VM'
