EveryOS 0.1.54 improves Tailscale and NetBird connection reliability and Remote Access status.

- Secure registration-key delivery now works with both VPN clients on Linux. Keys remain transient
  and are kept out of command-line arguments, environment variables, named files and EveryOS logs.
- Exit-node use and exit-node advertisement are shown separately. A Pi offering an exit node no
  longer appears to be missing that role merely because it is not using another exit node.
  Unreadable telemetry is shown as Unknown, and Tailscale administrator-approval states are explicit.
- Reconnecting a registered Tailscale device preserves its SSH, advertised subnet and exit-node
  preferences. Leave the registration-key field empty for an already registered device; EveryOS
  does not reset existing preferences or bypass provider approval to complete a connection.
- Saved NetBird settings now apply to an already connected client through an explicitly confirmed
  reconnect. The confirmation explains possible temporary access loss. Other VPN connections stay
  unchanged, and a second provider also requires conflict consent while the first is connecting.
- Connection failures distinguish key delivery, rejected keys, identity conflicts, certificates,
  policy restrictions, service availability and network problems without exposing private output.
  Unreadable peer lists remain errors, and the Tailscale screen shows refresh errors alongside
  retained data instead of presenting missing details as No or unlimited key validity.
- Settings follow refreshed server configuration while preserving unsaved local edits. Remote
  Access and peer-list loading now use the same compact indicator as other Settings sections,
  with clear exit-node labels on desktop and mobile in both Turkish and English.

For installations older than 0.1.49, a host administrator must apply the package-service migration
before updating through an older restricted EveryOS worker:
https://github.com/goktugcy/everyos/blob/main/docs/updates.md#existing-installations-affected-by-the-old-unit-policy.
Wait for all APT/dpkg/initramfs and EveryOS release operations to finish before changing or
restarting package services. Reloading systemd alone does not replace a running service namespace.
Existing damaged boot images still require administrator verification and recovery outside EveryOS.
