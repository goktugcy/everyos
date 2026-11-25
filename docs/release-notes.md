EveryOS 0.1.56 fixes shared-folder setup and adds permanent Quick Share link deletion.

- Creating an NFS or SMB shared folder now sends only the approved folder fields to the Linux
  account worker. This fixes the generic system-operation error that prevented folder sharing.
- Quick Share offers separate Revoke and Delete actions. Delete permanently removes the link,
  sharing record and access grants, including inactive links, while keeping shared and received
  files. Revoking a link still keeps its record in the list.
- Desktop file names keep their position and fitted font size on hover, selection and keyboard
  focus. Long names remain available in the tooltip and accessible label.
- Files dragged into the Shelf's inner drop area are accepted by the browser and added as
  references without moving their source files.
- Touch and hold in Terminal opens copy, paste and text-selection actions. A normal text field
  supports native selection and manual paste when browser clipboard access is unavailable.

Quick Share API clients that need revocation without deleting the record should use
POST /api/sharing/quick/:id/revoke. DELETE /api/sharing/quick/:id now removes the record.
Both actions retain owner checks, file-write permission, CSRF protection and explicit confirmation.

EveryOS 0.1.55 adds Network Sharing to Files and Settings.

- Connect to NFS, SMB and SFTP folders from Files. Native Linux mounts use managed systemd
  units and on-demand automounts; SFTP verifies the server's SSH fingerprint before authentication.
- Share selected local folders through NFS or encrypted, authenticated SMB using the linked
  Linux account's permissions. Confirmed setup installs missing dependencies and manages only
  EveryOS-owned configuration while retaining existing host services and settings.
- Send selected files or receive uploads through expiring, revocable Quick Share links and QR
  codes. Guests use a browser without an EveryOS account on a private network over HTTPS.
  Passwords, one-time access and transfer quotas are available.
- Network file operations reuse Files previews, editing, copying and transfer progress. Discovery
  uses mDNS; existing Tailscale and NetBird status helps identify private-network addresses.
- Saved credentials are encrypted, resources belong to their creating account, and Linux identity
  changes clean up that account's managed resources before committing the change.
- Network Sharing includes all ten interface languages and phone-sized layouts. Loading indicators
  stay compact and centered when opening the section or installing dependencies.

Native sharing requires AMD64/ARM64 Linux with systemd. Managing host mounts, exports and services
requires a linked Linux account with unlocked sudo. Sharing does not configure router ports,
firewall rules or public tunnels. See docs/network-sharing.md for protocol and recovery details.

For installations older than 0.1.49, a host administrator must apply the package-service migration
before updating through an older restricted EveryOS worker:
https://github.com/goktugcy/everyos/blob/main/docs/updates.md#existing-installations-affected-by-the-old-unit-policy.
Wait for all APT/dpkg/initramfs and EveryOS release operations to finish before changing or
restarting package services. Reloading systemd alone does not replace a running service namespace.
Existing damaged boot images still require administrator verification and recovery outside EveryOS.

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
