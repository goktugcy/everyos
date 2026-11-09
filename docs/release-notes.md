EveryOS 0.1.51 adds a shared desktop and Dock shortcut editor.

- Right-click the desktop or Dock and choose Add shortcut. The shared dialog has sections for
  installed Docker applications, built-in and installed official EveryOS apps, and manual links.
- Docker discovery reads existing installations, published TCP ports and available presentation
  labels without starting or modifying containers. Suggested addresses and artwork can be edited.
  Simulated data is labeled and never used to infer a real address.
- Give a shortcut its own name and icon URL, or upload a private PNG, JPEG or WebP image. Link and
  image addresses are limited to HTTP(S), and embedded URL credentials are rejected. Uploaded
  artwork is validated, scoped to its owner and protected from deletion while referenced.
- Add a shortcut to the desktop, Dock or both. Edits appear immediately in every placement and
  persist across reloads. Removing one placement keeps the others; removing the last cleans up
  the shared record. Existing native shortcuts remain supported.
- EveryOS app shortcuts open the actual application window with its existing permissions.
  Managed Docker shortcuts keep resolving current published ports when the suggested address is
  unchanged; an explicit address override becomes a fixed link. External links open a separate
  tab without an opener or referrer.
- Confirmed official app removal also removes its custom shortcut aliases. The dialog supports
  keyboard context menus and narrow screens, with save and cancel actions kept visible while
  the form scrolls.

For installations older than 0.1.49, a host administrator must apply the package-service migration
before updating through an older restricted EveryOS worker:
https://github.com/goktugcy/everyos/blob/main/docs/updates.md#existing-installations-affected-by-the-old-unit-policy.
Wait for all APT/dpkg/initramfs and EveryOS release operations to finish before changing or
restarting package services. Reloading systemd alone does not replace a running service namespace.
Existing damaged boot images still require administrator verification and recovery outside EveryOS.
