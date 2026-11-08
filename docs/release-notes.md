EveryOS 0.1.50 adds automatic official app updates and independent app publication.

- Active installed official apps update automatically to newer compatible signed versions.
  Catalogs refresh at startup and every 15 minutes. Updates wait while an app window or widget
  is open, then retry when it closes. App data, settings and existing grants are preserved.
- New capabilities still require approval, including newly requested standard capabilities.
  The App Store handles that review. Disabled apps, revoked versions, conflicting sources and
  community/private installations are excluded from automatic installation.
- Successful updates create localized notifications and refresh desktop app runtime URLs, names
  and widgets without reloading the page. Notification preferences remain respected. Polling,
  reconnect and visibility recovery cover missed events. Failed updates notify administrators,
  are audited without secrets and retry with backoff.
- Publishers can release official application packages through a separate protected app-tag
  workflow. It tests, verifies and signs app artifacts without building another Linux package or
  changing the EveryOS version. Existing clients keep the same signed official catalog address.
- Both publication workflows share the catalog sequence and publication lock. Immutable package
  URLs, retained catalog snapshots, uploaded-asset digest checks and no-downgrade checks protect
  the app catalog and existing OS release assets.

Automatic installation and its notifications require this one-time EveryOS upgrade. Subsequent
official app publications can use the independent app workflow. Older clients retain their
existing manual App Store update action.

For installations older than 0.1.49, a host administrator must apply the package-service migration
before updating through an older restricted EveryOS worker:
https://github.com/goktugcy/everyos/blob/main/docs/updates.md#existing-installations-affected-by-the-old-unit-policy.
Wait for all APT/dpkg/initramfs and EveryOS release operations to finish before changing or
restarting package services. Reloading systemd alone does not replace a running service namespace.
Existing damaged boot images still require administrator verification and recovery outside EveryOS.
