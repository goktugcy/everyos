# Disposable Linux SDK qualification

These scripts only accept root inside the dedicated `lima-everyos-sdk-qual-20261025` VM.
They refuse a real host, the owner's Pi, a different hostname and (without `--resume`) an
already configured EveryOS account. The VM has no host mounts. Do not rename a real host to run them.

`install-prior.py /path/to/prior-assets` requires the immutable public v0.1.36 release assets
downloaded from `goktugcy/everyos`. It verifies the signed bootstrap, checks that its embedded Python
verifier matches the separate Python asset, then uses that verifier to install the actual signed
baseline package from root-owned local fixture storage.

`node tests/sdk-linux/fixtures.ts` builds a real Notes-derived package with a separate fixture
namespace and two versions. Its local registry, publisher keys and index snapshots are explicitly
ephemeral and are written only under ignored `dist/sdk-linux-fixture/`. They are never release assets.

`qualification.py --disposable-host --candidate /path/to/candidate --fixtures /path/to/app-fixtures`
requires a fresh baseline and a candidate directory containing:

- `everyos_0.1.37_arm64.deb` built from the actual candidate source;
- `release.json` signed with a newly generated test key, and its `everyos-release-public.pem`;
- `signed-prior.json`, the exact published baseline payload signed with that same test key.

The last file keeps the original 0.1.36 package bytes available for verified rollback after switching
the disposable host to its test trust root. No production private key is needed. The harness creates
its own Linux account, sets its fixture password through stdin, authenticates PAM/sudo through the
normal EveryOS API and performs the upgrade, app lifecycle, backup and supervised restore. Credentials
remain in a root-only file in this VM. `--resume` is exclusively for diagnosing a harness failure
before the core upgrade, using that same saved fixture account; it does not skip product assertions.

The measured report is `/srv/everyos-sdk-qualification/qualification.json`. Copy it out before stopping
this newly created VM. It binds both package digests and explicitly identifies virtualization and the
absence of production community acceptance. The documented observations are in
`docs/sdk-release-acceptance.md`; physical Pi and native amd64 qualification remain separate gates.
