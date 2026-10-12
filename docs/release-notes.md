EveryOS 0.1.6 adds notifications for new EveryOS versions.

- Production installations check the configured signed release source automatically. Available
  versions appear in the notification center and in eligible toasts. Clicking opens Settings → About.
- The same pending version notifies once across polling and API restarts. Reading or dismissing it
  stays respected; installing the version or discovering a newer release resolves the old condition.
- Manual checks from About update the same notification immediately. Checks run without an open
  browser, use hourly remote refresh and a 15-minute failure backoff, and never install automatically.
- Existing notification permissions, muted categories and toast preferences are preserved. The
  trusted publisher key and `goktugcy/everyos` release source remain unchanged.

See [the notification guide](https://github.com/goktugcy/everyos/blob/main/docs/notifications.md)
for behavior and delivery settings. This release also includes the Home Assistant device panel,
brand/model recognition and all-entity widgets introduced in 0.1.5.
