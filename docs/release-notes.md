EveryOS 0.1.53 fixes repeated NetBird installation failures when refreshing Linux package lists.

- Public VPN repository keys and source files are now readable by APT's `_apt` account while the
  privileged agent retains its private umask for unrelated data. Newly created repository directories
  also receive the required read and traversal permissions.
- Retrying an installation repairs permissions on exact, verified EveryOS repository files created
  by an earlier attempt. Administrator-managed repositories, changed files, symbolic links and hard
  links are preserved; repository signing checks remain enforced.
- Installation errors now distinguish signature, network, repository configuration, permissions and
  disk-space failures without exposing private repository or proxy credentials.

For installations older than 0.1.49, a host administrator must apply the package-service migration
before updating through an older restricted EveryOS worker:
https://github.com/goktugcy/everyos/blob/main/docs/updates.md#existing-installations-affected-by-the-old-unit-policy.
Wait for all APT/dpkg/initramfs and EveryOS release operations to finish before changing or
restarting package services. Reloading systemd alone does not replace a running service namespace.
Existing damaged boot images still require administrator verification and recovery outside EveryOS.
