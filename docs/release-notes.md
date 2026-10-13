EveryOS 0.1.17 expands Home Assistant device controls and groups cards by room.

- Supported lights expose brightness, color, Kelvin temperature, white mode, effects, flash and transition.
- Fan speed/presets, oscillation, cover position/tilt, climate temperature ranges and modes,
  humidity, media settings, vacuum modes, valves, water heaters, sirens and mower controls follow
  the capabilities actually reported by Home Assistant.
- Settings use sliders, a color picker, choices and numeric fields with explicit Apply. Reported
  values update from real device state; unsupported settings are not presented as available.
- Room headings and filters use Home Assistant areas, including entity-level room overrides.
  A device split between rooms cannot expose another room's entities in its details.
- Server authorization and fresh capability/range validation remain required for every action.
  Selected scopes are preserved. Custom integration actions remain accessible in the original
  Home Assistant interface through a token-free link.

The publisher key, release source, default wallpaper and existing EveryOS features remain included:
transparent empty/full Trash with confirmed Empty trash, connection request metadata, customizable
menu bar, application folders/context menus, whole-item selection, automatic update notifications,
passwordless signed EveryOS update confirmation, automatic app defaults/ports and Linux account permissions.
