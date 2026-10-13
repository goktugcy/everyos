EveryOS 0.1.15 adds transparent trash artwork and live connection information.

- The trash icon is an open metallic wire basket with transparent gaps and no colored app tile.
  Its empty, paper-filled and unavailable states continue to use the account's real trash listing.
- A text-only Encrypted/Unencrypted indicator opens a compact connection popover. HTTPS is
  detected from the browser connection, including reverse-proxy deployments; loopback HTTP
  is still labeled unencrypted. Possible VPN and backend hops are explicitly outside this check.
- While open, the panel shows actual API request methods, status codes, durations and content
  sizes. It never records passwords, tokens, raw URLs, payloads or invented encrypted packets.
  Closing, locking or changing sessions discards the live list.

The publisher key, GitHub release source and default wallpaper remain unchanged. Applications
in Files, automatic hourly update notifications, passwordless EveryOS update confirmation,
automatic application defaults and port allocation, Linux account permissions and Home Assistant
integration remain included.
Menu bar customization, application context menus and persistent installation shortcuts remain included.
Whole-item icon/name selection from 0.1.13 remains included.
