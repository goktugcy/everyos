EveryOS 0.1.46 adds built-in Linux system backups and recovery.

- Open Backups → Linux backups to protect Linux system files, all system and user data,
  or selected directories with explicit exclusions. Preview the actual capture scope before
  saving a plan.
- Schedule hourly, daily, weekly or monthly backups. Choose encrypted or unencrypted Borg
  repositories, compression and optional retention rules. Follow background progress, cancel
  a backup and review its history.
- Verify archive data and extract a backup into a fresh recovery directory. File permissions,
  ownership and supported Linux metadata are preserved. Recovery keeps the running system
  intact; live databases still need application-aware backups.
- Install a missing BorgBackup dependency directly from the backup screen on supported APT
  hosts, with account-password confirmation and Linux sudo permission. Installation progress,
  failures and retries remain visible, and the executable is checked before backups are enabled.

Linux backups require a root agent and BorgBackup 1.2.5 or a newer 1.x release. The existing
consistent EveryOS database and app-data backup remains available in its own tab.
