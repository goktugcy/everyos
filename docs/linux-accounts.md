# Linux account linking

EveryOS roles and Linux permissions are separate checks. Linking never creates a Linux account,
changes a password, edits sudoers, adds groups, or changes ownership of existing host files.

## Use

1. An EveryOS administrator opens **Users**, selects a user, and chooses **Link a Linux account**.
2. Select an existing local login account and confirm both the administrator's EveryOS password
   and that Linux account's password. PAM verifies authentication and account restrictions.
3. The terminal uses the linked account's UID, primary and supplementary groups, home and login
   shell. EveryOS's `terminal:access` permission is still required.
4. Files offers the Linux home as an additional location. Configured host locations and enabled
   read-only system roots use the linked identity. Ordinary Linux permissions and ACLs apply;
   API-owned EveryOS personal folders retain their existing ownership and backup coverage.
5. For privileged system management, open **Settings → Account → Linux account and permissions**
   and verify the Linux password. A successful sudo check authorizes this EveryOS session for
   five minutes. The password is discarded immediately. Locking/signing out clears the grant.

Root, service accounts, nologin shells and accounts below the host's `UID_MIN` are not offered.
An SSH-key-only account with a locked password cannot pass password authentication; use an
existing account with working PAM authentication. There is no password bypass or root selector.

## Privileged operations

Service control, APT mutations, managed application state, application-data backup transfers and
EveryOS release installation require a linked account and actual sudo authorization. Sudo runs
the root-owned, fixed `sudo-witness.mjs` with the packaged Node interpreter. The witness accepts
no commands, prints one fixed marker only when it runs as root, and exits. Membership of a group
called `sudo` is never treated as proof of authorization. Standard Ubuntu full sudo policies work;
passwordless authorization is checked directly on each operation when no temporary grant exists.

Long-running system jobs authorized at their start can finish after the re-authentication window
expires. New privileged calls need a valid grant or passwordless sudo. Unattended scheduled jobs
cannot reuse a browser password; their owner needs an existing passwordless sudo policy.

Command-specific sudoers rules for unrelated executables do not authorize EveryOS's witness.
They continue to work normally in the terminal; EveryOS does not broaden these policies or
interpret them as unrestricted administrator access. Read-only root telemetry (CPU, power,
hardware and mount summaries) remains shared monitoring data governed by EveryOS roles.

Without a sudo grant, Docker uses the account's existing socket permissions, including its
supplementary groups. With a verified sudo grant, its privileged Docker actions remain subject
to EveryOS role checks and protected-container policy. Private host widget sources are collected
on behalf of each subscriber, and cached Docker statistics require a fresh authorized host read.

## Boundary and lifecycle

- The root agent owns `/var/lib/everyos-agent/identities/bindings.json` (0600 in a 0700 directory).
  Records contain only EveryOS UUID, Linux account name and pinned UID. The API cannot edit them.
- `identity.*` and `files.*` are explicit, strictly validated operations in the agent registry,
  with permissions, deadlines and audit logging. Passwords, file contents and terminal keystrokes
  are not included in audit details. Linux authentication is limited to five attempts per account
  per minute, in addition to PAM and EveryOS re-authentication limits.
- PID 1 starts UUID-named, bounded account units with real credentials outside the agent's
  read-only `/home` namespace. Account workers receive no agent key, API secret or password.
  File transfers use bounded chunks, per-worker handles, quotas and idle cleanup.
- Host file operations always run unprivileged as the account, including while a sudo grant is
  active. Sudo does not silently turn the file manager into a root file browser.
- Removing/changing a link closes that user's PTYs and file workers and clears all grants.
  Disabling/deleting an EveryOS user removes the link. UID changes invalidate it. Group-file
  changes recreate file/system workers on their next request. Terminal group membership follows
  ordinary Linux login-session behavior; open a new terminal after changing host groups.
- Existing EveryOS homes, desktop contents, trash and backups remain intact. Linux homes are
  additional host locations; they are not silently added to EveryOS's personal-data archives.
- No generic shell, arbitrary command or browser-selected shell/UID operation is introduced.
  The existing interactive terminal remains the explicitly authorized PTY operation.

## API

| Route                                 | Permission / confirmation                                     |
| ------------------------------------- | ------------------------------------------------------------- |
| `GET /api/users/linux-accounts`       | `users:manage`; eligible accounts and existing links          |
| `PUT /api/users/:id/linux-account`    | `users:manage`; `{ account, currentPassword, linuxPassword }` |
| `DELETE /api/users/:id/linux-account` | `users:manage`; `{ password }` (EveryOS administrator)        |
| `GET /api/account/linux`              | Authenticated caller's account and `privilegedUntil`          |
| `POST /api/account/linux/unlock`      | `{ linuxPassword }`; PAM and sudo verification                |
| `POST /api/account/linux/lock`        | Clears the current session's temporary sudo grant             |

All mutation routes retain session, unlocked-account, CSRF and server-side role checks. The file
manager keeps its existing HTTP routes, including ranged downloads, uploads, text editing and
trash. Transfers between EveryOS personal storage and Linux locations check both boundaries.
