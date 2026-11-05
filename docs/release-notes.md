EveryOS 0.1.48 adds Linux backup plan controls and fixes long JSON lines.

- Disable and re-enable backup plans without losing their saved schedule, custom task timing
  or repository credentials. Disabled plans block new backups while existing archives remain
  available for verification and recovery. A running operation continues until explicitly stopped.
- Remove a backup plan with account-password confirmation. Its configuration, linked task and
  saved encryption passphrase are removed; archives and recovery directories stay on disk.
  The confirmation shows the retained repository path and explains recovery access after removal.
  Running plans must finish or be stopped before removal.
- The refresh icon rotates continuously throughout backups, other archive operations and
  cancellation, without restarting on each status update. Reduced-motion preferences are respected.
- JSON Studio 1.0.2 wraps long JSON lines and unbroken strings inside the editor instead of
  overlapping the adjacent panel. Wrapping preserves the original JSON content and also works
  in narrow windows.
