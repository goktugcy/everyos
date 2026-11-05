EveryOS 0.1.47 improves built-in Linux backup controls.

- Delete a selected backup from its archive row with account-password confirmation and an
  explicit permanent-deletion warning. Only that archive is removed, then unused repository
  space is reclaimed; other backups, source files and staged recovery directories are preserved.
- The refresh icon spins until the overview and expanded archive list finish loading.
- The stop-operation button shows a progress indicator until the running operation actually
  finishes, including the time needed to stop Borg safely. Failed stop requests can be retried.

Interrupted deletion and incomplete repository cleanup remain visible with their actual outcome.
Deleting a backup is permanent, including when it is the last copy.
