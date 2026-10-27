import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import host_guard


class HostGuardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.marker = Path(self.directory.name).resolve()/'marker.json'
        self.enterContext(patch.object(host_guard, 'MARKER', self.marker))
        self.enterContext(patch.object(host_guard.os, 'geteuid', return_value=0))
        self.enterContext(patch.object(host_guard.socket, 'gethostname', return_value='unrelated-host'))
        self.enterContext(patch.dict(os.environ, {
            'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
            'GITHUB_REPOSITORY': 'goktugcy/everyos', 'GITHUB_RUN_ID': '1234', 'GITHUB_SHA': 'a'*40,
        }, clear=True))

    def trusted_marker(self):
        self.marker.write_text(json.dumps(host_guard.ci_identity()))
        self.marker.chmod(0o600)
        fields = list(self.marker.lstat())
        fields[4] = 0
        return os.stat_result(fields)

    def test_exact_disposable_vm_is_accepted(self):
        with patch.object(host_guard.socket, 'gethostname', return_value='lima-everyos-sdk-qual-20261025'):
            self.assertEqual(host_guard.require_disposable_host(), 'disposable Lima VZ VM')

    def test_unprivileged_process_is_refused(self):
        with patch.object(host_guard.os, 'geteuid', return_value=501):
            with self.assertRaises(RuntimeError):
                host_guard.require_disposable_host()

    def test_real_or_self_hosted_machine_is_refused(self):
        for change in ({'GITHUB_ACTIONS': 'false'}, {'RUNNER_ENVIRONMENT': 'self-hosted'},
                       {'GITHUB_REPOSITORY': 'another/repository'}, {'GITHUB_SHA': ''}):
            with patch.dict(os.environ, change):
                with self.assertRaises(RuntimeError):
                    host_guard.require_disposable_host()

    def test_hosted_flags_without_marker_are_insufficient(self):
        with self.assertRaises(FileNotFoundError):
            host_guard.require_disposable_host()

    def test_current_private_root_marker_is_accepted(self):
        info = self.trusted_marker()
        with patch.object(host_guard, 'lstat', return_value=info):
            self.assertEqual(host_guard.require_disposable_host(), 'disposable GitHub-hosted VM')

    def test_replayed_unowned_public_or_linked_marker_is_refused(self):
        original = self.trusted_marker()
        for index, value in ((4, 501), (0, stat.S_IFREG | 0o644), (0, stat.S_IFLNK | 0o600)):
            fields = list(original)
            fields[index] = value
            with patch.object(host_guard, 'lstat', return_value=os.stat_result(fields)):
                with self.assertRaises(RuntimeError):
                    host_guard.require_disposable_host()
        self.marker.write_text(json.dumps({**host_guard.ci_identity(), 'runId': '9999'}))
        with patch.object(host_guard, 'lstat', return_value=original):
            with self.assertRaises(RuntimeError):
                host_guard.require_disposable_host()


if __name__ == '__main__':
    unittest.main()
