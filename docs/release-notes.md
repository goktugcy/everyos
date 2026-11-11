EveryOS 0.1.52 brings Tailscale and NetBird together in Settings → Remote Access.

- Install, configure, connect and disconnect providers independently. NetBird supports its cloud
  service and self-hosted HTTPS management servers. Existing Tailscale diagnostics, widgets and
  EveryOS HTTPS Serve integration remain available.
- Keep both providers installed and connected. EveryOS warns about observed or potential DNS,
  overlapping subnet and default-route/exit-node conflicts, and explicitly identifies unreadable
  information. Starting a second connection requires acknowledgment; EveryOS does not automatically
  disable the other provider or rewrite its network policy.
- Provider actions use validated privileged-agent operations with administrator and linked Linux
  sudo permissions. Initial headless registration uses a provider auth/setup key passed through
  stdin; EveryOS does not retain it in settings, command-line arguments, environment or logs.
- Automatic provider installation supports Debian/Ubuntu and uses signed APT packages, reviewed
  vendor signing-key pins and existing package-environment safeguards. Installation continues in
  the agent when the browser or API connection closes.
- A refreshed Remote Access screen includes official provider logos, clear connection badges,
  compact network summaries and labeled DNS/route switches, with light/dark theme and mobile layouts.
- About now provides icon links to the GitHub repository, everyos.net and Buy Me a Coffee. The
  introductory product description has been removed for a cleaner header.

For installations older than 0.1.49, a host administrator must apply the package-service migration
before updating through an older restricted EveryOS worker:
https://github.com/goktugcy/everyos/blob/main/docs/updates.md#existing-installations-affected-by-the-old-unit-policy.
Wait for all APT/dpkg/initramfs and EveryOS release operations to finish before changing or
restarting package services. Reloading systemd alone does not replace a running service namespace.
Existing damaged boot images still require administrator verification and recovery outside EveryOS.
