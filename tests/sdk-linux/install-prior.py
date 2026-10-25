import os, socket, subprocess, pathlib, sys, json, hashlib
from host_guard import require_disposable_host
require_disposable_host()
root=pathlib.Path('/srv/everyos-sdk-qualification')
if pathlib.Path('/var/lib/everyos/everyos.db').exists():
    raise SystemExit('Refusing to replace an existing installation')
root.mkdir(mode=0o700,exist_ok=True)
public=pathlib.Path(sys.argv[1])
source=root/'releases'
version=source/'download/v0.1.36'; version.mkdir(parents=True,exist_ok=True)
latest=source/'latest/download'; latest.mkdir(parents=True,exist_ok=True)
for file in public.iterdir():
    if file.is_file():
        dest=version/file.name
        dest.write_bytes(file.read_bytes()); dest.chmod(0o600)
(latest/'release.json').write_bytes((version/'release.json').read_bytes())
subprocess.run(['apt-get','update','-qq'],check=True)
subprocess.run(['openssl','pkeyutl','-verify','-pubin','-inkey',str(version/'everyos-release-public.pem'),'-rawin','-in',str(version/'install.sh'),'-sigfile',str(version/'install.sh.sig')],check=True)
bootstrap=(version/'install.sh').read_text()
embedded=bootstrap.split("<<'EVERYOS_PYTHON_INSTALLER'\n",1)[1].split('\nEVERYOS_PYTHON_INSTALLER',1)[0]
assert embedded.rstrip()==(version/'install.py').read_text().rstrip(), 'Python asset differs from the signed bootstrap'
subprocess.run(['python3',str(version/'install.py'),'--public-key',str(version/'everyos-release-public.pem'),'--source',source.as_uri()],check=True)
print('Prior published release installed in disposable VM',flush=True)
