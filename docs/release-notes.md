EveryOS 0.1.29 fixes the pulse after file drops and deleting on USB disks.

- Dropping files on a Files window or the desktop no longer leaves the pulse showing its drop
  arrows; they also go away when a drag is cancelled.
- While files move, the bottom two rows of the pulse fill like a progress bar, and the amount
  moved, the total and the speed are written right above them ("↑ 12,4 MB / 48 MB · 3,2 MB/s").
  The usual dots return when the transfer has finished.
- Deleting files on FAT, exFAT and NTFS USB disks works again: they go to the trash like
  everywhere else and can be restored or emptied.

EveryOS 0.1.28 brings USB disks to the desktop, Google Drive into Files, and live progress for
every transfer.

- Plug in a disk and it appears on the desktop and in Files at once; the pulse in the middle of the
  menu bar says "New disk connected" and a notification pops up. Mount it with one click, and
  choose to have it mounted by itself whenever it is plugged in. Removing a disk is announced the
  same way, with a warning when it was pulled out without ejecting. Remembered disks can be
  forgotten in Settings › Disks.
- Connect your own Google Drive in Settings › Connections (an administrator adds the server's own
  Google client once, with a step-by-step guide). Browse My Drive and Shared with me in Files,
  upload, download, rename and trash, and copy files and folders between Drive and EveryOS both
  ways. Google Docs, Sheets and Slides are copied as Office files.
- Uploads and copies show their speed (MB/s) and time left: in the pulse, which turns into a
  progress bar and has a new Transfers tab, in a storage item in the menu bar, on a shelf at the
  end of the dock, in Files and on phones. Every transfer can be stopped.
- The pulse no longer covers menu bar items; it moves into the free space between them.

EveryOS 0.1.27 brings the essentials of a home server: restart and shutdown, disks, notifications
outside the app and settings for installed apps.

- Restart or shut down the server from the EveryOS menu or on your phone. EveryOS asks for your
  password, warns about work that would be interrupted (backups, app jobs, package upgrades) and
  never interrupts an EveryOS update. Updates shows when installed updates need a restart.
- Settings › Disks lists your disks and mounts extra and USB disks, once or at every startup. They
  appear in Files under Disks. EveryOS never formats a disk and never touches the system disk.
  Remove a disk safely before unplugging it.
- Notifications can also reach you through ntfy, Telegram, e-mail or a webhook (Discord, Slack or
  JSON), each with its own minimum severity, categories and language, and a test message.
- Change an installed app's settings later. When its catalog definition changes, EveryOS notifies
  you and applies the update with your values kept.
- The notification center is available on phones.
- Restarting, shutting down and mounting disks need your linked Linux account with sudo
  authorized; the dialogs offer to authorize it when it is missing.

EveryOS 0.1.26 adds an AI chat widget and lets you switch the model behind every chat.

- The chat shows the model in use next to the assistant, and every answer names the model that
  wrote it, so a switch in the middle of a conversation stays visible.
- A model menu lists what the assistant can use and switches it: local models change at once,
  Hermes (installed by EveryOS or found on the host) lists its own providers and models and uses
  the choice from the next message without changing Hermes's settings, and an OpenClaw installed
  by EveryOS is reconfigured and restarted after a confirmation.
- A Hermes found on the host now shows its real default model instead of a generic label.
- Right-click a chat to add it to favorites, archive it or delete it. Favorites sit in a
  collapsible list at the top, archived chats in an archive at the bottom; writing in an archived
  chat brings it back.
- New AI chat widget (AI category, desktop and sidebar): pick the local model, Hermes or OpenClaw
  in the widget, continue the latest chat, browse the history, switch the model and open the
  chat window.

EveryOS 0.1.25 lets you tune how local models answer.

- A new Behavior section for local models, in plain language: a personality template (helpful
  assistant, short and clear, teacher, coding helper) or your own instructions, answer language,
  creativity, answer length, conversation memory and avoid repetition. It is also offered,
  optionally, in the "Add assistant" wizard.
- Every local chat now sends instructions to the model. Without your own, it is asked to answer
  honestly and clearly, not to invent facts, and to reply in your language.
- Ollama servers are addressed through Ollama's own chat API, so memory and repetition settings
  apply; other servers receive the matching OpenAI-compatible settings.
- "Try it" sends a sample message with unsaved settings to the saved model; nothing is stored.
- Models under 4B parameters show a warning and a shortcut to download a larger model.

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
