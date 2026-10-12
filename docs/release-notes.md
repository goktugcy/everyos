EveryOS 0.1.7 adds selectable, persistent Linux privilege verification.

- Settings → Account offers 15 minutes, 30 minutes, 1 hour, 5 hours, 1 day, 1 week,
  1 month (30 days), and indefinite authorization. Verify the linked Linux password once.
- Explicit grants survive signing out, desktop locking, browser closure, and API/agent restarts.
  Change duration with another verification or revoke the grant manually across all sessions.
- Passwords are never stored. Every privileged call still checks current Linux account restrictions,
  sudoers and EveryOS permissions. Linux policy denial and identity changes revoke saved grants.
  Host files continue to use the linked account's ordinary permissions.
- Older clients without a duration retain the former five-minute session-only behavior.
  Existing Linux links are permanent; upgrading never silently grants indefinite privilege.

See [Linux account linking](https://github.com/goktugcy/everyos/blob/main/docs/linux-accounts.md)
for scope, lifecycle and API details. The trusted publisher key and `goktugcy/everyos` release
source remain unchanged. This release also includes automatic EveryOS release notifications,
the Home Assistant device panel, brand/model recognition and all-entity widgets.
