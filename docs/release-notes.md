EveryOS 0.1.0 is the first packaged Linux release.

- Debian packages for arm64 and amd64 include a verified, pinned Node runtime and systemd services.
- Settings → About and Updates → EveryOS provide authenticated, signed version checks and installation.
- An independent update worker verifies package identity and integrity, requires a fresh safety
  backup, and restores both the prior package and database after a failed upgrade.
- The authenticated CLI supports status, doctor, backup, restore and version updates.
- Backups include all account home folders. Desktop and folder views support multiple selection,
  selection rectangles, recoverable trash and customizable folder icons.
- Linux battery and power details are available in the navigation bar.
- The renamed public release source is `goktugcy/everyos`; existing legacy source settings retain
  publisher trust while resolving to the new repository.

The supported installation targets are Debian 12+, Ubuntu 22.04+ and compatible modern 64-bit
Raspberry Pi distributions with systemd 248+, glibc 2.34+ and kernel 5.14+.

For a first installation, independently verify the publisher's public-key fingerprint, place
`everyos-release-public.pem` in a root-owned file, and run:

```sh
sudo python3 install.py --public-key /root/everyos-release.pem
```

The published public key is a distribution convenience, not an independent trust proof. Obtain
its fingerprint through a trusted channel before using the installer. Protect the publisher's
private key and keep it out of source control and application hosts.
