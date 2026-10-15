EveryOS 0.1.24 adds local AI models and a simpler AI assistants setup.

- Chat directly with a local model on your own server; messages never leave it. Works on any
  Linux host with Docker, AMD64 or ARM64.
- AI Assistants finds model servers already running: Ollama, LM Studio, llama.cpp and vLLM,
  installed natively or in Docker (including CasaOS), and lists their models.
- EveryOS can install one shared Ollama for all accounts, with NVIDIA or AMD GPU acceleration
  when Docker can use the GPU (administrator approval), and download or delete models with live
  progress. Suggested models fit the host's memory. Changes to an Ollama EveryOS did not install
  need an extra confirmation.
- Hermes and OpenClaw installed by EveryOS can use the EveryOS Ollama over a private network, or
  another local model server on the host.
- Redesigned AI Assistants settings: one card per assistant with its state, model and source,
  an "Add assistant" wizard (type, source, model, review) and clearer Connection, Model and
  Advanced sections in plain language.
- The chat opens the first ready assistant and shows the model in use.

EveryOS 0.1.23 imports real Hermes chats and explains agent chat failures.

- Chat import skips Open WebUI background tasks (title, tag and follow-up generation), which
  previously filled the import, and scans further back for real conversations.
- Tool-call steps without text no longer crowd out messages, so imported chats are complete.
- Importing again removes background tasks copied by 0.1.22 and refreshes partially imported
  chats; chats you continued in EveryOS are never changed.
- When the agent reports a failed answer, the chat shows its reason (for example, a model the
  provider does not support) instead of a generic system error. Keys are redacted.
- The chat list updates after an import and after a failed message.

EveryOS 0.1.22 fixes Hermes chat import and announces new versions sooner.

- Importing Hermes chats no longer fails with an internal error. Hermes records fractional
  session timestamps; they are now stored as whole milliseconds.
- New EveryOS releases are checked every five minutes instead of every hour, so a published
  version appears in notifications within about six minutes. Each check still downloads and
  verifies only the signed release metadata; nothing installs automatically.

EveryOS 0.1.21 uses official theme-aware agent logos.

- Hermes Agent and OpenClaw use locally bundled official vector marks with preserved shapes.
- Transparent monochrome marks follow the active theme foreground/accent color.
- Agent Settings, discovery, chat and menu bar use the same marks; owned agent installations
  also show them in Applications, desktop shortcuts and the dock.
- Upstream source references and license notices are included with the assets.

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
