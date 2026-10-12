EveryOS 0.1.3 fixes HTTP setup copying and adds per-user Linux account linking.

- The setup command copy button works on ordinary HTTP host-IP connections, with real success
  feedback and a manual-copy message if browser policy refuses copying.
- Users → Link a Linux account associates an EveryOS user with an existing local Linux login.
  Linking requires EveryOS re-authentication and the Linux account's PAM-verified password.
  Root and service accounts are excluded; account names and numeric UIDs are pinned in root-owned
  records. No Linux password is saved and no Linux permissions, groups or sudoers rules are changed.
- Terminal sessions use the linked account's actual UID, supplementary groups, home and login
  shell. Startup waits for the real PTY before inviting input. Different users no longer share
  one production terminal identity. Existing installations must link each user in the Users app.
- Files adds the linked Linux home. Host file access, uploads, ranged downloads, text editing and
  recoverable trash run with that account's real filesystem permissions. Existing EveryOS personal
  homes, desktop files and backup coverage are preserved; Linux homes are additional locations.
- Settings → Account → Linux account and permissions verifies existing sudo authorization for
  five minutes in the current EveryOS session. Privileged system operations still require their
  EveryOS permission and protected-service/container policy. Restricted sudoers rules are not
  broadened. Linux file-manager access remains unprivileged while sudo is verified.
- Changing/removing the association closes its PTYs and file workers and clears sudo grants.
  Disabling/deleting an EveryOS account removes its Linux association. Host widget streams use
  the subscriber's identity, and cached Docker reads retain Linux authorization checks.

The signed installer and update source remains `goktugcy/everyos`. Fresh one-command installs
still detect usable host interfaces at port 7470; upgrades preserve existing network settings,
wallpapers, configuration, credentials and personal files.

Supported targets: Debian 12+, Ubuntu 22.04+ and compatible 64-bit Raspberry Pi distributions
with systemd 248+, glibc 2.34+ and kernel 5.14+. The package includes the verified Node runtime,
Python PTY relay, PAM configuration and the existing independent signed-update worker.

See [Linux account linking](https://github.com/goktugcy/everyos/blob/main/docs/linux-accounts.md)
for use, authorization limits and command-specific sudoers compatibility.
