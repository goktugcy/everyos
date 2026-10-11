EveryOS 0.1.2 improves first installation and the personal desktop experience.

- The verified installer automatically enables IPv4 host interfaces at port 7470 for a new API configuration. The installer
  detects real LAN/Tailscale addresses and prints URLs that respond to the health check.
- Localhost access remains available for CLI commands and the independent signed-update worker.
  Existing installations keep both unchanged loopback defaults and custom network configurations; no firewall, router or Tailscale
  settings are changed by the installer.
- Ubuntu systemd checks use `systemctl --version`, including systems without a `systemd` command
  on the command search path.
- The desktop works over a plain HTTP host-IP URL, including initial widget IDs and upload IDs.
- The bundled EveryOS mountain wallpaper is the default Liquid Dark background. Explicit saved
  wallpaper selections remain in effect. The README introduces EveryOS as a personal OS with
  owner-provided logos, desktop screenshot and wallpaper.

The initial 0.1.0 release introduced:

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
