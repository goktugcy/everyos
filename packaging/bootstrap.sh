#!/usr/bin/env bash
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

fail() { printf 'EveryOS installation failed: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 0 ]] || fail 'This installer does not accept arguments.'
[[ $(uname -s) == Linux ]] || fail 'A Linux host is required.'
[[ $EUID -eq 0 ]] || fail 'Run the installer with sudo bash.'
[[ -d /run/systemd/system ]] || fail 'A running systemd host is required.'
command -v apt-get >/dev/null && command -v dpkg >/dev/null || fail 'An APT-based host is required.'
[[ ! -e /var/lib/everyos/everyos.db && ! -e /var/lib/otuken/otuken.db ]] ||
  fail 'Existing data detected. Use the authenticated EveryOS update workflow or explicit legacy migration.'

architecture=$(dpkg --print-architecture)
[[ $architecture == arm64 || $architecture == amd64 ]] || fail 'Only arm64 and amd64 are supported.'
read -r _ systemd_version _ < <(systemd --version)
[[ $systemd_version =~ ^[0-9]+$ ]] && (( systemd_version >= 248 )) || fail 'systemd 248 or newer is required.'
glibc_version=$(getconf GNU_LIBC_VERSION)
dpkg --compare-versions "${glibc_version#glibc }" ge 2.34 || fail 'glibc 2.34 or newer is required.'
kernel_version=$(uname -r)
dpkg --compare-versions "${kernel_version%%-*}" ge 5.14 || fail 'Linux kernel 5.14 or newer is required.'

missing=()
command -v python3 >/dev/null || missing+=(python3)
command -v openssl >/dev/null || missing+=(openssl)
[[ $(dpkg-query -W -f='${Status}' ca-certificates 2>/dev/null || true) == 'install ok installed' ]] || missing+=(ca-certificates)
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l APT_LISTCHANGES_FRONTEND=none
# Fresh cloud images can have no package lists, even when verification prerequisites exist.
apt-get update
if (( ${#missing[@]} )); then
  apt-get install --yes --no-remove --no-install-recommends "${missing[@]}"
fi

# The Python verifier requires a root-owned key with no writable ancestors, unlike /tmp.
workdir=$(mktemp -d /var/lib/everyos-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$workdir"' EXIT
cat > "$workdir/publisher.pem" <<'EVERYOS_PUBLISHER_KEY'
@@EVERYOS_PUBLIC_KEY@@
EVERYOS_PUBLISHER_KEY
cat > "$workdir/install.py" <<'EVERYOS_PYTHON_INSTALLER'
@@EVERYOS_PYTHON_INSTALLER@@
EVERYOS_PYTHON_INSTALLER
python3 "$workdir/install.py" --public-key "$workdir/publisher.pem"
