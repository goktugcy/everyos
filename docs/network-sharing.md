# Network Sharing & File Transfer

Network Sharing is built into **Files → Network → Manage** and **Settings → Network Sharing**.
It uses the existing Linux account view, file previews/editor/clipboard, TransferService,
Pulse/Dock/menu-bar progress, permission checks and privileged agent. It is not an Official App,
container, VPN or a new long-running EveryOS daemon.

## Access and setup

Native mounts/exports, dependency installation, Samba accounts and service changes require
`system:manage`, a linked Linux account and that account's unlocked sudo. SFTP and Quick Share
require `files:read` and `files:write`. Records and credentials belong to their creating EveryOS
user. Another administrator does not inherit their connection credentials. Keep the API unprivileged.

Settings detects native dependencies and provides explicitly confirmed installation/start/reload.
It reuses protected APT handling on Debian/Ubuntu: `nfs-common`, `cifs-utils`, `nfs-kernel-server`,
`samba`, `openssh-server`, `avahi-utils`/`avahi-daemon`, plus `python3` for export binding. Installation runs in the background with visible status.
Supported native targets are AMD64/ARM64 Linux with systemd. Development simulation is labeled and
does not change real host services. Quick Share and SFTP still perform real operations in development.
No router ports, firewall rules, public proxy/tunnel, VPN enrollment or certificate are created.

Overview reports connections, shared folders and errors. Refresh obtains actual host/endpoint
state. A successful port test does not prove authentication, a mount or access to a particular file.

## NFS client

Add a connection with server, port (normally 2049) and absolute export path. Prefer NFS 4.2/4.1/4;
select 3 explicitly when required. Use read-only unless writes are needed. An optional mount folder
name selects a single directory beneath `/mnt/everyos-network/<EveryOS-user-id>/`; arbitrary host
mount paths are not accepted. This name is fixed after creation; recreate to change it.

**On demand** authorizes Files to activate this saved connection. **Keep after restart** enables
its systemd automount at boot. With on demand off, use Connect manually. Disconnect stops only its
owned units and refuses a busy unmount. Remove deletes configuration, never the remote data.
External NFS/CIFS mounts are shown to administrators for reference and are never adopted or changed.
`/etc/fstab` is untouched.

Only `.automount` units participate in `multi-user.target`; boot does not wait for a remote mount.
Mount startup has a 12-second deadline; idle automounts can unmount after 120 seconds. NFS uses
`hard` TCP mounts: silently using `soft` could corrupt writes. A lost server can leave kernel I/O
waiting for recovery. Files returns bounded errors using individual 12-second agent-call deadlines,
TCP preflight and bounded outstanding account-worker requests. Cancelling a request does not claim
to terminate a hard-NFS write safely. Restore the network and reconnect; do not force unmount writes.

DNS addresses are validated and pinned on save. Explicitly edit/save after a server address changes.
NFSv3 may also require administrator-managed RPC/firewall policy; port 2049 alone is insufficient.
Linux account UID/GID and the remote server's actual permissions determine file access.

## NFS server

Choose a specific local Linux folder in Files → Share folder, or Shared Folders → Share folder.
Select NFS, explicit IPv4/IPv6 client addresses/CIDRs and read-only/write. Wildcards, unspecified
addresses and `/0` are rejected. The UI displays `server:/srv/everyos-network-shares/<share-id>`.

NFS AUTH_SYS is unencrypted and is not strong user authentication. Use a trusted LAN/private VPN
with restrictive rules. EveryOS uses **`root_squash,all_squash`** and maps clients to the creator's
linked Linux UID/GID (`anonuid`/`anongid`). Clients cannot impersonate another server user by
supplying its UID. This intentionally provides an authorized folder account, not transparent
multi-user UID passthrough. The creating Linux account must be able to read/write the source.

An existing UID account worker validates the source. Inspection sends only `root`, `path` and
`readOnly` through the strict `files.share.inspect` contract; export metadata belongs to the root
agent's separate export operation. A fixed root-owned systemd oneshot pins its
device/inode and bind-mounts it without following path symlinks. Its mount is `nosuid,nodev,noexec`
and read-only when selected. Each export has its own filesystem ID and subtree checking to enforce
the approved folder boundary (see [exports(5)](https://man7.org/linux/man-pages/man5/exports.5.html)).
Renames can require clients to reopen stale handles. Only `/etc/exports.d/everyos-<id>.exports` is persisted; targeted
`exportfs` updates avoid global re-export. Other exports are displayed read-only and retained.
Disabling/removing a share does not delete source data. A renamed/replaced source inode needs reapproval.

## SMB client and server

Connect with server/port, share name, username/password and optional domain. SMB3.1.1 is the default;
3.0 and explicitly selected 2.1 are supported. SMB1 is unavailable. SMB3 mounts require encryption
(`seal`); SMB2.1 shows an unencrypted-traffic warning. Secrets are sealed at rest and written only to
a root-only runtime credential file. They never appear in units, argv, responses or audit details.
CIFS forces ownership to the creating Linux UID/GID with private modes and disables DFS referrals.

To share a local folder, choose SMB, share name and existing Linux users. An empty selection uses
the creator's linked account. The Samba account action sets a selected non-system user's local Samba
password entry; it does not create a Linux account or change its Linux password. LDAP/remote Samba
account backends are not modified. The password is transient and not stored by EveryOS. Linux
permissions and ACLs must allow the selected users; the share does not bypass them.

Managed shares require encrypted SMB and disable guest/symlink traversal. They live in
`/etc/samba/everyos-network.conf`. A marked trailing include is appended to `smb.conf`, preserving
its existing bytes, inode, mode and ACLs. `testparm` precedes controlled reload. Changed managed
files or colliding administrator share names are refused. Failed changes attempt to restore prior
configuration. Edit/disable closes only the managed share's Samba connections before changing its bind.

### Other devices

- **iPhone/iPad:** Files → Browse → … → Connect to Server. Enter the displayed `smb://server`,
  choose Registered User and the shown Linux/Samba username with its Samba password, then open
  the share. Built-in Files handles uploads/downloads/editing according to permissions.
- **macOS:** Finder → Go → Connect to Server → displayed `smb://server/share`.
- **Windows:** Explorer → `\\server\share` or Map Network Drive; use the authorized account.
  EveryOS-created shares require modern encrypted SMB3 clients.
- **Android:** Quick Share works in a normal browser. Persistent SMB/SFTP requires a file manager
  supporting that protocol; Android has no universal built-in SMB client.
- **Linux/NAS:** Use the device's existing NFS/SMB mount tools with the displayed export/share.
  Configure only the intended private-network addresses and authorized credentials.

## SFTP client and existing SSH server

Add server, SSH port, username, absolute remote folder and password or SSH private key/passphrase.
Probe obtains a SHA256 host fingerprint before authentication. Verify it independently with the
server administrator, then explicitly confirm it. Unknown/changed keys are not silently trusted.

The encrypted SSH adapter uses no FUSE, remote shell or executed remote content. Listing, search,
previews, text editing, mkdir, rename, uploads/downloads and cross-location copying integrate into
Files. Remote path components and symlinks are checked; the SSH account remains the server-side
authorization boundary. **SFTP deletion is permanent**, with an explicit confirmation. It does not
promise EveryOS Trash recovery. Native NFS/SMB deletion uses normal Files trash, temporarily
unavailable while its root is offline.

Uploads use private temporary files, exact byte lengths and rename after successful completion.
Overwriting a file needs OpenSSH's atomic-rename extension. Available statvfs checks remote space;
otherwise actual remote write errors are authoritative. No fake free-space guarantee is made.
Failed uploads attempt temporary-file cleanup; a lost session can leave an inaccessible temporary
file needing cleanup after reconnection. Search/copy/delete have bounded depth and item counts.

Settings shows existing OpenSSH service/socket state and effective SSH ports. Use the Linux
account's existing authorized key/password (`sftp -P <port> user@server`). Confirmed installation,
start and reload preserve `sshd_config`. Root SSH access and password/key policy are not changed.

## Browser Quick Share

Select regular files → Quick Share. For a folder, first use Files' ZIP compression. Choose expiry
(15 minutes by default, maximum 24 hours), optional password, download quota and optional one-time
access. Create/copy the link or show the QR. A guest presses Open in a browser and downloads only
the selected files without an EveryOS account.

For receiving, use the destination folder's Receive files action or the Quick Share tab. Choose a
writable folder and cumulative byte quota. Open its link on a phone and select files/photos/videos.
Uploads stream to that folder with collision renaming, progress/cancel and the existing EveryOS
transfer indicators. Each link allows at most 100 completed/currently reserved uploaded files,
including empty files, as well as its byte quota.

HTTPS is required except loopback development. Recipients must connect through private LAN,
CGNAT VPN or IPv6 ULA/link-local addresses. Trusted reverse-proxy client information is respected;
untrusted forwarded headers cannot bypass this. A public proxy URL does not publish a private
share. Use existing EveryOS HTTPS/Remote Access setup. Sharing itself opens no port or tunnel.

The 256-bit token stays in the URL fragment, not request URLs/access logs. SQLite stores its hash
and a SecretBox-sealed owner copy for Copy Link. Access produces a short-lived hashed grant and
share-scoped HttpOnly Strict cookie. Upload also requires a matching grant header and same-origin
checks. Passwords use the existing password hasher. Public access allows 60 requests/minute/IP.
Forged IDs do not allow directory listing. Owner disablement, file-role revocation, expiry, quotas
and revocation are checked on the server and while streaming.

Quick Share offers separate **Revoke** and **Delete** actions with confirmation. Revoke immediately
disables the link and keeps its list entry. Delete permanently removes the owner's record, sealed
link token, password hash and access grants, including expired, revoked and exhausted shares.
Existing recipient grants stop working, and active streams fail their next capability check.
Shared source files and files already received remain intact. Audit events retain only their normal
non-secret action/record metadata.

The owner uses `POST /api/sharing/quick/:id/revoke` to revoke and
`DELETE /api/sharing/quick/:id` to delete; both require `files:write`, session CSRF protection and
`{ "confirm": true }`. The DELETE endpoint now removes the record instead of only revoking it.
Another user's ID is not accessible. Deleted public links return `410 SHARING_EXPIRED`.

One-time means **one successful browser access grant**. That browser may download the selected
files within the adjusted quota. Each GET, including a Range/retry request, consumes a download
count. HTTP ranges support download continuation within that quota. Uploads and cross-server
copies do **not** resume partial files: retry explicitly. Completed files remain after cancelling
a multi-file copy. A move deletes its sources only after all copies succeed and source metadata
still matches. API restart ends in-memory transfers, clears stale upload reservations and preserves
absolute expiry and one-time claims. Inaccessible remote partial files are not called successful.

## Discovery, VPNs and troubleshooting

Discovery uses Avahi/mDNS `_smb._tcp`, `_nfs._tcp`, `_sftp-ssh._tcp`, not aggressive IP scanning.
Missing Avahi, multicast isolation or missing advertisements may return no services. Manual entry
always works. Discovery does not validate export paths or trust SSH keys. Manual probes allow four
concurrent requests and 12/minute/person.

Tailscale/NetBird status and private addresses reuse Remote Access. Enter those addresses normally.
Both devices need the same private network and appropriate VPN ACL/firewall rules. Manage VPN
settings in Remote Access: sharing never enrolls/connects providers or changes DNS/routing/ACLs.
A VPN does not turn NFS AUTH_SYS into per-user authentication.

For failures check host service state, private reachability, protocol/version, dependencies,
fingerprint, Linux binding/permissions and VPN state. A port test is not a file-operation test.
Conflicting host configuration needs administrator review; EveryOS will not overwrite it to force
success. Busy unmounts leave data and records intact. An unavailable agent is explicit; SFTP and
Quick Share remain independently usable.

## Technical reference and restore

Migration 21 creates owner-scoped `network_connections`, `network_shares`, `quick_shares` and
hashed `quick_share_grants`. SecretBox contexts bind credentials to their owner/record/purpose.
`/api/sharing` uses session/CSRF/permission middleware. Capability-only `/api/quick-share` is mounted
before session loading with independent CSRF/network/HTTPS policy; recipients gain no desktop/sudo.

Typed agent operations are `sharing.status`, `sharing.mount.apply/control/access/remove`,
`sharing.export.apply/remove`, `sharing.service`, `sharing.install`, `sharing.smb.account`,
`sharing.discover`, and internal `files.share.inspect`. Only mount.access can activate an already
authorized enabled on-demand mount without another sudo prompt; it cannot change settings.

Native Files operations run in existing Linux UID workers. SFTP pools are lazy: 32 clients globally,
four/owner, four channels/client, 30-second idle cleanup, pinned keys, DNS validation, deadlines and
keepalives. Metadata, loopback, mapped and multicast destinations are blocked. Streams use bounded
buffers, not whole-file memory. Network copy/Quick Share reuse two active transfers/person and cap
these entry points at 16 active/queued jobs. Audit never contains capabilities or credentials.

Actual mountinfo must match an owner's managed source before a native Files root is exposed.
Database rows alone never prove a mount/export is active. Runtime credentials are restored from
sealed agent state at startup. API backups preserve SQLite according to existing policy; native
agent state/units/service configuration require explicitly scoped Linux backup. Matching original
installation keys are necessary to decrypt secrets. A restore on another machine does **not**
silently recreate privileged mounts/exports. Rebind the proper account, unlock sudo and explicitly
save/reapprove the desired connection/share. Missing host state remains unavailable.

Changing/removing a Linux binding, or disabling/deleting its EveryOS account, first stops and
removes that owner's managed native mounts/exports within the agent's identity-change lock.
Existing source files and other owners' resources are retained. Native resources require the acting
administrator's unlocked sudo. A busy/conflicting mount prevents unlink/delete; it is never forced.
A failed Linux password check leaves resources untouched. Retained API records become disabled and
need explicit save/reapproval after a new binding; account deletion cascades their metadata. SFTP
sessions close on account disable/delete. Native configuration is not left active without an owner.

## Qualification

Automated coverage includes actual temporary files and SSH/SFTP sessions/keys, Files cross-server
tasks, owner/role boundaries, expiry/revocation/quotas, queue cancellation, live stream revocation,
unsafe paths, managed-unit contracts and configuration preservation. NFS and SMB regression tests
also enforce the exact account-worker inspection contract before privileged changes; the native
Linux fixture applies the same strict schema instead of accepting extra export fields. Browser tests exercise QR
creation and account-free 375-pixel download/video-upload flows; native simulation stays labeled.

`scripts/check-network-sharing-linux.ts` and the PR/manual Linux matrix run only in disposable
GitHub-hosted Ubuntu 24.04 AMD64/ARM64 VMs. They exercise actual NFS/CIFS exports/mounts, UID
permissions, manager restart, offline automount and OpenSSH SFTP. This cannot run on a macOS host.
Full machine reboot, supported Debian releases, busy hard-NFS outage/recovery and physical iPhone/
iPad Files interoperability also need qualification on disposable Linux/device environments before
release. A browser viewport test does not claim mobile Safari or physical iPhone SMB coverage.
