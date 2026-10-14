EveryOS 0.1.20 adds Hermes Agent and OpenClaw integration.

- Agent Settings installs a pinned official isolated package or connects an existing agent.
- Per-account model/provider credentials, confirmed lifecycle actions and live connection state.
- Native streaming chat with encrypted private history, explicit stop, reload recovery and deletion.
- Configurable menu bar icons show each agent and open its chat quickly.
- Automatic discovery of native/profile and official Docker installations, with reviewed settings
  and readable chat import. Existing native files and services are never modified.
- Existing application ownership, Linux account policy, permissions, audit and backup checks apply.
- Managed API ports are allocated automatically on loopback; tools are off by default.
- Partial turns are never committed or automatically replayed; locks and access changes close streams.

Docker/Compose v2 is required for managed installation. No personal host directories or Docker
socket are mounted. Advanced OAuth, channels/plugins and multimodal uploads remain in independently
configured agents; see [AI agents](ai-agents.md). All previous EveryOS features remain included.

EveryOS 0.1.19 makes version updates visible without reloading the page.

- About and EveryOS update panels receive live verified status, including newly available and
  installed versions, last check time and installation state. Older pending reads cannot replace
  a newer live/manual result; polling remains available when streaming is unavailable.
- Notifications continue with the menu bar bell hidden and on narrow screens.
- A notification response arriving after the tab becomes hidden is deferred, so the notice is
  not marked as seen before it can actually be displayed.
- Pending unread version notices missed while a tab was hidden, offline or disconnected are
  recovered when it returns. A read-only polling fallback covers event-stream outages.
- The same seen version is not repeatedly toasted; read/dismiss/resolution and mute preferences
  remain respected. Session changes and locks cancel pending notification reads.

The hourly remote release-check cadence, manual installation, administrator authorization,
signed verification and required safety backup remain unchanged. The publisher key, default
wallpaper, Home Assistant device controls and room grouping, transparent Trash with confirmed
emptying, application folders/menus, connection metadata, menu bar customization, Linux account
permissions and other existing features remain included.
