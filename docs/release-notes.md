EveryOS 0.1.8 improves icon captions and simplifies application installation.

- Selected desktop applications and file icons highlight the glyph, without coloring the name.
  Unbroken long names wrap and shrink; exceptionally long names expand in full on interaction.
- App Store installs automatically use the linked Linux account's UID/GID and the host timezone.
  PUID, PGID and TZ no longer require user input.
- Docker assigns an available host port automatically. EveryOS verifies and pins the real binding
  so restart and image update retain the port. Existing host services are preserved.
- Optional variables and manual fixed ports are under Advanced settings. Required external
  credentials/endpoints remain explicit. Launch the application after installation to complete
  its own setup in its native panel.

The trusted publisher key and release source remain unchanged. This release includes the
persistent Linux privilege durations, version notifications and Home Assistant integration
from previous versions. See the [App Store guide](https://github.com/goktugcy/everyos/blob/main/docs/app-store.md)
for defaults, port allocation and installation boundaries.
