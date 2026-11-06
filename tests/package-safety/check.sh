#!/bin/bash
set -euo pipefail
# Only the fresh GitHub-hosted VM is used; no real user host/package transaction is touched.
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo "This check requires a disposable GitHub-hosted runner" >&2
  exit 1
fi
check_root=$(sudo mktemp -d /run/everyos-package-safety-XXXXXX)
cleanup() { sudo rm -rf -- "$check_root"; }
trap cleanup EXIT
for unit in everyos-agent everyos-update; do
  grep -qx 'ProtectKernelModules=no' "packaging/systemd/$unit.service"
done
grep -qx 'ProtectKernelModules=yes' packaging/systemd/everyos-api.service
baseline=$(stat -c '%d:%i' /usr/lib/modules)
for protection in yes no; do
  # A trusted read-only OS command demonstrates the actual systemd mount behaviour.
  result=$(sudo systemd-run --quiet --wait --pipe --collect \
    -p "ProtectKernelModules=$protection" -p ProtectSystem=strict -p PrivateNetwork=yes \
    -p ProtectHome=yes -p MemoryMax=64M -p TasksMax=8 -p RuntimeMaxSec=15 \
    /usr/bin/stat -c '%d:%i' /usr/lib/modules 2>/dev/null || true)
  if [[ "$protection" = no ]]; then [[ "$result" = "$baseline" ]];
  else [[ "$result" != "$baseline" ]]; fi
done
echo "Real systemd: old protection masks modules; corrected package-service policy preserves host visibility"
node_root=$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")
sudo mkdir -p "$check_root"/{usr,lib,lib64,node,dev,proc,sys,scratch,source/packages/system/src/apt}
sudo cp packages/system/src/apt/{safety.ts,safety.node-test.ts} "$check_root/source/packages/system/src/apt/"
sudo cp packages/system/src/host-paths.ts "$check_root/source/packages/system/src/"
echo '{"type":"module"}' | sudo tee "$check_root/source/package.json" >/dev/null
# No network, credentials or writable host mounts are exposed to target code.
sudo systemd-run --quiet --wait --pipe --collect \
  -p "RootDirectory=$check_root" -p WorkingDirectory=/scratch \
  -p "BindReadOnlyPaths=/usr:/usr /lib:/lib -/lib64:/lib64 $node_root:/node" \
  -p ProtectSystem=strict -p NoNewPrivileges=yes -p 'CapabilityBoundingSet=' \
  -p PrivateNetwork=yes -p PrivateDevices=yes -p ReadOnlyPaths=/dev \
  -p 'InaccessiblePaths=/proc /sys' -p RestrictAddressFamilies=AF_UNIX \
  -p 'TemporaryFileSystem=/scratch:rw,size=128M,nosuid,nodev' \
  -p MemoryMax=256M -p CPUQuota=100% -p TasksMax=32 -p LimitNOFILE=128 \
  -p LimitFSIZE=16777216 -p RuntimeMaxSec=60 \
  /usr/bin/env -i HOME=/scratch TMPDIR=/scratch PATH=/node/bin:/usr/bin:/bin \
    /node/bin/node --max-old-space-size=128 --test /source/packages/system/src/apt/safety.node-test.ts
