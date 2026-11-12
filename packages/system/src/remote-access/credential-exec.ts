/**
 * Linux cannot reopen libuv's stdin socket as /dev/stdin. The packaged Python runtime
 * replaces itself with the fixed VPN CLI and supplies a sealed, anonymous RAM fd instead.
 * The key never gets a filesystem name, environment entry or command-line argument.
 */
export const VPN_CREDENTIAL_EXEC = String.raw`
import fcntl
import os
import sys

def unavailable():
    sys.stderr.write("EVERYOS_VPN_CREDENTIAL_INPUT_UNAVAILABLE\n")
    sys.exit(126)

try:
    target = sys.argv[1]
    if not os.path.isabs(target) or os.path.basename(target) not in ("netbird", "tailscale"):
        unavailable()
    data = sys.stdin.buffer.read(16386)
    if not data.strip() or len(data) > 16385:
        unavailable()
    fd = os.memfd_create("everyos-vpn-credential", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
    os.fchmod(fd, 0o600)
    offset = 0
    while offset < len(data):
        offset += os.write(fd, data[offset:])
    os.lseek(fd, 0, os.SEEK_SET)
    fcntl.fcntl(fd, fcntl.F_ADD_SEALS,
                fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL)
    os.dup2(fd, 0, inheritable=True)
    os.close(fd)
    os.execv(target, sys.argv[1:])
except (OSError, AttributeError, IndexError, ValueError):
    unavailable()
`;
