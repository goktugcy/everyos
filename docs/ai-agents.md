# AI assistants: local models, Hermes and OpenClaw

EveryOS provides a native chat application (**AI Chat**) and **Settings → AI Assistants** for
three kinds of assistant: a **local model** (a direct chat with a model server on the host), Hermes
Agent and OpenClaw (formerly Clawdbot). The settings page shows one card per assistant with its
state, model and source, plus **Add assistant**, a four-step wizard (type → source → model →
review). A configured assistant's **Settings** open its Connection, Model and Advanced sections.
A configurable menu bar module shows each configured assistant's state, model and a chat shortcut.
Everything works on any Linux host with Docker (AMD64 or ARM64), not only on Raspberry Pi.

## Local models

A local model chats directly with an OpenAI-compatible server; no agent runtime is involved and
messages stay on the host. The source is the EveryOS Ollama, a discovered server or a typed address
(another machine of the network or another port). An API key is optional and is sent only when set.
The model is picked from the server's list, or typed when the server does not list its models.
Status checks the server's `/v1/models` and reports a missing model as an error.

Discovery (Settings → AI Assistants → Local models) finds, without sending anything else than
read-only GET requests to loopback:

- the EveryOS Ollama;
- servers on the default ports 11434 (Ollama), 1234 (LM Studio), 8080 (llama.cpp) and 8000 (vLLM),
  plus ports of processes named like these servers in the agent's listening-socket list (servers on
  non-default ports);
- containers of the official Ollama, llama.cpp, vLLM and LocalAI images with a published port,
  for example the CasaOS/Big Bear Ollama. EveryOS-managed projects are excluded.

Ollama servers report their version and model details (`/api/version`, `/api/tags`); others are
identified through `/v1/models`, where 401/403 marks a server that needs a key. Each server is
classified by whether EveryOS-managed agent containers can reach it: over the private AI network
(the EveryOS Ollama), through `host.docker.internal` when it listens on all interfaces, or not at
all when it listens on 127.0.0.1 only (direct chat still works). Actions name a server by its
discovered id and are always sent to `127.0.0.1`; no request accepts a caller-supplied server URL
for model management.

### Behavior

A local chat sends a system message and sampling settings with every request, edited in plain
terms in its **Behavior** section (also offered, optionally, in the wizard):

- **Personality**: templates (helpful assistant, short and clear, teacher, coding helper) fill the
  instructions in the interface language; editing them makes them custom (at most 4,000
  characters). Settings saved before this existed use built-in instructions that ask for honest,
  clear answers and no invented facts.
- **Answer language**: the user's language, always Turkish or always English.
- **Creativity** (temperature 0.1–1.2), **answer length** (300/1,200/4,000 tokens) and **avoid
  repetition** (Ollama `repeat_penalty` 1.0–1.3, otherwise `frequency_penalty` 0–0.8).
- **Conversation memory**: the context window (2K–16K tokens), applied by Ollama servers only.

Ollama servers (the EveryOS Ollama, or any server answering `/api/version`) are addressed through
Ollama's own `/api/chat` so these options apply; others receive OpenAI-compatible parameters on
`/v1/chat/completions`. **Try it** sends a sample message with the unsaved settings to the saved
model and stores nothing. Models with fewer than 4B parameters show a warning and a shortcut to
download a larger one.

## EveryOS Ollama

An administrator can install one system-wide Ollama; every account allowed to use assistants shares
its models while chat histories stay per account. It is a repository-owned built-in application:
the official multi-architecture `ollama/ollama` 0.40.4 image pinned by digest (about 3.8 GB on
AMD64, 2.8 GB on ARM64), models persisted in its owned app-data directory, a Docker-assigned
`127.0.0.1` port for EveryOS, `no-new-privileges` and dropped `NET_RAW`/`NET_ADMIN`. Image pulls
may take up to 45 minutes and an application job up to 75 minutes, so slow links can install it.
It is managed through the normal application jobs (start, restart, retry; removal from
Applications) and shows in Applications with the local-model symbol.

Acceleration is chosen at installation and can be changed later:

- **CPU** works everywhere.
- **NVIDIA** is offered only when Docker reports the NVIDIA runtime or CDI devices; it reserves all
  GPUs through Compose device reservations.
- **AMD** uses the separate ROCm image (AMD64 only) and is offered only when `/dev/kfd` exists;
  it maps `/dev/kfd` and `/dev/dri`.

GPU access is the application `devices` risk: only administrators can approve it, and the agent
re-checks the approval on install and update. Built-in reconfiguration accepts no other risk.

### Models

On Ollama servers EveryOS lists models with size, parameters and quantization, downloads models
(at most two downloads at a time, with live progress and cancellation) and deletes them after
confirmation. Names must look like Ollama library names (`[host/][namespace/]name[:tag]`).
Suggestions come from a fixed list of verified library models filtered by the host's memory.
A server EveryOS did not install, such as CasaOS's Ollama, may be used by other applications:
downloads and deletions there require an extra explicit confirmation. Downloads and deletions are
audited as `ai-local.model-pull` / `ai-local.model-delete`.

## Managed installation

Choose **Let EveryOS install it**, a model and, for cloud providers, an API key, then confirm the
installation (the wizard's review step or the confirmation dialog). The model can be:

- the **EveryOS Ollama**: the agent joins EveryOS's private internal Docker network and reaches it
  at `http://everyos-ollama:11434/v1`; no key is needed and models are picked from its list;
- another discovered **host server** that listens beyond loopback, through
  `http://host.docker.internal:<port>/v1` (every managed agent has a `host-gateway` entry);
- **OpenRouter** or **OpenAI** (API key required);
- **another model server** at any OpenAI-compatible `/v1` address, key optional. A loopback address
  inside the container addresses the container itself.

The private network `everyos-ai` is created by the agent as an internal bridge labeled as owned by
EveryOS; a same-named network that EveryOS did not create is never joined. Only EveryOS's own AI
templates can request membership: catalog templates lose every `x-` key except inline files before
installation, and the agent validates the requested services and aliases before creating anything.

The Linux host must already have Docker Engine and Compose v2. Existing EveryOS application
management checks, Linux account binding/sudo policy, audit, asynchronous jobs, ownership markers,
rollback and agent-side Compose validation remain in force. EveryOS does not execute either
upstream's remote installation script or install Docker automatically.

Each account gets its own deployment and data. Only official multi-architecture stable images
are used, pinned by digest in `apps/api/src/modules/ai-agents/templates.ts`. Docker atomically
allocates an unused **127.0.0.1** port; the browser talks exclusively to EveryOS, never to that
agent port or its secret. No host files, Docker socket, host networking, extra capabilities or
privileged mode are granted. Agent working data is persistent in the owned app-data directory;
the encrypted deployment/configuration is also included in the EveryOS database backup.

Saving an installed managed agent's settings explicitly recreates that owned deployment.
The desired configuration is staged separately from the applied configuration. The agent validates
the previous ownership digest before changing it; failure restores the running configuration,
while success commits the new digest. A retry resumes the staged update after an interrupted job.
Start/stop/restart/retry actions require confirmation. Updates do not silently adopt a new upstream
image: a future EveryOS template revision must pin and verify it first. Application menu updates
using the current digest preserve the same reviewed image.

Tools are disabled by default. Enabling tools allows Hermes's terminal/files/web/memory toolsets
or OpenClaw's coding profile inside that account's container. It does not grant host access.
OpenClaw's automatic Tool Search is also disabled when tools are off, so no discovery/control
schemas are sent to the model provider. See the upstream [Tool Search setting](https://docs.openclaw.ai/tools/tool-search).
The Hermes maximum tool-step limit is configurable. Other advanced agent settings, messaging
channels, OAuth provider onboarding, arbitrary plugins/MCP servers and multimodal uploads are
outside this native form; an independently configured installation can be connected instead.

## Existing installation

AI Assistants scans automatically on opening and every minute while visible. It detects the
linked Linux account's default `.hermes`, Hermes named profiles, `.openclaw`, named OpenClaw
profiles and legacy `.clawdbot` data, fixed executable locations and official Docker containers.
Discovery failure is distinguished from no accessible installation data. Existing EveryOS-owned
deployments are not adopted as external containers.

Native files are read through two fixed `ai.discover`/`ai.snapshot` agent operations. They always
run in the bound Linux account worker with its UID/groups, including when that account has a sudo
grant. Root fallback, arbitrary paths/commands, symlink escapes and executable config content are
not allowed. Native configuration and environment files are parsed as data only; secret values
never appear in discovery responses. JSON5 OpenClaw settings and environment secret references
are supported, including Gateway token/password authentication.

Choose **Import** to review settings and/or readable chats before copying. Settings replace only
that account's EveryOS connection; original agent files and running services stay intact. Imported
keys/transcripts are sealed. Settings without a readable Gateway key can be imported for completion
in the form. A settings fingerprint prevents importing a changed source after discovery.

Chat import supports Hermes's read-only SQLite state, OpenClaw's current active SQLite transcript
(including bounded zstd payloads), and older/archived JSONL text transcripts. It copies at most
20 conversations, the last 40 user/assistant text messages of each, within byte limits. Attachments,
tool records, text-less tool-call steps and complete remote memory are not copied. Open WebUI's
background title/tag/follow-up generations ("### Task:" prompts sent through the same API) are
not chats: they are skipped, and Hermes's 200 most recent sessions are scanned to find real chats
behind them. Unsupported/unreadable/limited history is labeled. Repeat imports never overwrite a chat
continued in EveryOS; continuing a chat moves its timestamp. An imported copy still at its source
timestamp is refreshed from the source, and such copies of Open WebUI tasks are removed.
Docker metadata can suggest a connection address; unreadable container secrets are entered manually.

Choose **Connect to an existing installation**, its address, model name and access key. A URL ending
in `/v1` is also accepted. Custom Hermes profiles can use their advertised API model ID.

- Hermes: enable `API_SERVER_ENABLED=true`, set `API_SERVER_KEY`, and run its Gateway. Default
  model ID: `hermes-agent`.
- OpenClaw: enable `gateway.http.endpoints.chatCompletions.enabled=true` and use its Gateway
  bearer token. Default model ID: `openclaw/default`.

EveryOS never modifies an external installation. External agent tools execute with that agent's
own permissions; its memory can be shared with other clients. Connection status checks the
authenticated `/v1/models` endpoint and selected API model, not provider billing/authentication.
Only a successful chat verifies that the configured model provider can answer. When the agent
itself reports a failed run (for example, its provider rejects the configured model), the chat shows
that agent-reported reason, with known keys redacted and at most 300 characters; HTTP error bodies
are never shown. A stream ending with `finish_reason: "error"` is never saved as an answer. Redirects,
cloud metadata and link-local addresses are refused; DNS is resolved and pinned for each request.

## Chat models

The chat window and the AI chat widget show the model in use next to the assistant, and every
saved answer records the model EveryOS asked for (`Hermes Agent · <model>`), so a switch in the
middle of a conversation stays visible. The model menu lists what the assistant can use and
switches it; EveryOS accepts only a model that the assistant or its provider has just listed.

| Assistant                        | Listed from                                                     | Switching                                                                              |
| -------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Local model                      | The connected server (`/api/tags` on Ollama, else `/v1/models`) | Immediately: the account's saved model changes                                         |
| Hermes (managed or existing)     | Hermes's own `GET /api/model/options` (authenticated providers) | Immediately: each request carries `model` and `provider`; Hermes's config is untouched |
| OpenClaw installed by EveryOS    | The provider EveryOS configured (`<provider>/models`)           | EveryOS rewrites its configuration and restarts it, after a confirmation               |
| OpenClaw EveryOS did not install | —                                                               | Not offered: its model is set in OpenClaw's own configuration                          |

Hermes's per-request selection is its documented API server behavior (supported by the Hermes
releases checked on 2026-10-16, including the owner's native `v0.21.4` canary): a request naming
both `model` and `provider` runs that turn with the provider's stored credentials, without
changing `config.yaml`. Choosing Hermes's own default (or nothing) sends the `hermes-agent` alias
again. A Hermes found on the host names its default only in that list; the chat asks for it once
so the chip shows the real model. A chosen Hermes model belongs to one Hermes and model setup:
saving a different address, mode, provider or model resets it. Older Hermes builds without the
route show "does not list models" and keep their default. Embedding, speech and image models are
left out of local and provider lists; lists are capped at 1,000 models per provider and cached
for a minute per account.

OpenClaw's `x-openclaw-model` header would switch per request too, but only to models already in
the gateway's catalog, which for EveryOS's provider holds just the configured model; a restart
with the new model is therefore the dependable route for installs EveryOS manages.

## Chat lists

Right-click (or the Menu key / Shift+F10) on a chat in the history adds it to favorites, archives
it, or deletes it after the usual confirmation. Favorites sit in a collapsible list at the top,
archived chats in a collapsible archive at the bottom (closed by default). The two are exclusive:
archiving drops the favorite mark and favoriting brings a chat back from the archive. Archived
chats can still be opened; sending a new message moves the chat out of the archive. Archived chats
count toward the 50-chat limit.

## AI chat widget

The `ai.chat` widget (AI category, desktop and sidebar, large or custom size) chats with the local
model, Hermes or OpenClaw from the desktop. The assistant is chosen in the widget itself and saved
in its configuration (`auto` follows the first ready assistant, like the chat window). It resumes
the most recent chat of that assistant, offers the history (with the same right-click menu), a
new chat, the model menu, and a button that opens the AI Chat window. It uses the same routes and
permissions (`apps:manage` and `terminal:access`) as the window and reads no shared data topic.

## Chat and access

All assistant routes, including local models, require both `apps:manage` and `terminal:access`. The current role bundles grant
both only to administrators. Each request and open chat stream is checked on the server; locking,
expiration, disabling an account or withdrawing a permission cancels its stream.

Conversation IDs are scoped to their owner **and** agent. Keys and transcripts are stored with
context-bound SecretBox encryption. Nothing includes stored keys in browser responses, logs or
audit details. Audits record operation/agent/conversation IDs and outcomes, never chat content.
Browser rendering is plain text, not HTML or executable Markdown.
Known configured credentials are scrubbed from imported text and live responses, including keys
split across delta boundaries, before storing or returning those texts.

The browser sends each message once using a CSRF-protected POST stream. UTF-8 chunks update the
conversation live. Reconnects never replay agent turns. A stop button, window close or session
lock aborts the request. The stop action also waits for the server to release the active turn,
including a pending DNS lookup. Already completed tool operations are not undone. Only fully
completed answers enter durable history; interrupted turns can be explicitly resent. The history stays
available after reload and has confirmed deletion. Deleting EveryOS history does not erase remote
agent memory or the model provider's records.

Bounds: 50 conversations per account/assistant, 40 committed messages per conversation, 16,000
characters per user message, 128 KiB per answer, 1 MiB of upstream stream data, 64 KiB per frame,
and a ten-minute run timeout. Start a new conversation when its context limit is reached.
Status polling runs every 15 seconds while visible and pauses for locked/signed-out sessions.
Model switches are audited as `ai-agent.model` with the model name, never with keys.
Development deployments are labeled simulated and never presented as a live chat runtime.

## Verification and primary references

Permission/CSRF/ownership, real HTTP streaming, encryption, interruption and fixed-template
installation tests run locally, including a real HTTP Ollama look-alike for discovery, direct chat,
streamed downloads and deletion. Targeted browser tests exercise the wizard, editor, local models
panel and chat against disposable HTTP fixtures. `Agent runtimes` CI runs the actual pinned images
on Linux AMD64 and ARM64: Hermes and OpenClaw against a fake local model provider (authenticated
readiness, model routing, streaming, tools-off behavior), and the EveryOS Ollama with a tiny model
(network creation, model download, direct streamed chat, and both agents reaching it over the
private AI network). It uses no personal credentials or paid model calls.

- [Hermes Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker)
- [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [OpenClaw Docker](https://docs.openclaw.ai/install/docker)
- [OpenClaw OpenAI API](https://docs.openclaw.ai/gateway/openai-http-api)
- [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Ollama Docker image and GPU support](https://docs.ollama.com/docker)
