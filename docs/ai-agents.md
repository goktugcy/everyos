# Hermes and OpenClaw

EveryOS provides a native chat application and **Settings → Agent Settings** for Hermes Agent
and OpenClaw (formerly Clawdbot). A configurable menu bar module shows each configured agent's
connection/operation state, selected model and a shortcut to its chat.

## Managed installation

Configure a model provider, model ID and provider API key, save, then confirm **Download and
install agent**. OpenRouter, OpenAI and custom OpenAI-compatible endpoints are supported.
Custom local endpoints may omit the provider key. A loopback endpoint inside the container
addresses the container itself; use a server address reachable from that container for host-local
Ollama/vLLM/other compatible model servers.

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

Agent Settings scans automatically on opening and every minute while visible. It detects the
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
20 conversations, the last 40 user/assistant messages of each, within byte limits. Attachments,
tool records and complete remote memory are not copied. Unsupported/unreadable/limited history is
labeled. Repeat imports skip existing source IDs and never overwrite a chat continued in EveryOS.
Docker metadata can suggest a connection address; unreadable container secrets are entered manually.

Choose **Connect an existing agent**, its server URL, API model ID and bearer key. A URL ending
in `/v1` is also accepted. Custom Hermes profiles can use their advertised API model ID.

- Hermes: enable `API_SERVER_ENABLED=true`, set `API_SERVER_KEY`, and run its Gateway. Default
  model ID: `hermes-agent`.
- OpenClaw: enable `gateway.http.endpoints.chatCompletions.enabled=true` and use its Gateway
  bearer token. Default model ID: `openclaw/default`.

EveryOS never modifies an external installation. External agent tools execute with that agent's
own permissions; its memory can be shared with other clients. Connection status checks the
authenticated `/v1/models` endpoint and selected API model, not provider billing/authentication.
Only a successful chat verifies that the configured model provider can answer. Redirects,
cloud metadata and link-local addresses are refused; DNS is resolved and pinned for each request.

## Chat and access

All agent routes require both `apps:manage` and `terminal:access`. The current role bundles grant
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

Bounds: 50 conversations per account/agent, 40 committed messages per conversation, 16,000
characters per user message, 128 KiB per answer, 1 MiB of upstream stream data, 64 KiB per frame,
and a ten-minute run timeout. Start a new conversation when its context limit is reached.
Status polling runs every 15 seconds while visible and pauses for locked/signed-out sessions.
Development deployments are labeled simulated and never presented as a live chat runtime.

## Verification and primary references

Permission/CSRF/ownership, real HTTP streaming, encryption, interruption and fixed-template
installation tests run locally. Targeted browser tests exercise the real EveryOS UI/API against
disposable HTTP agent fixtures. `Agent runtimes` CI runs the actual pinned images on Linux AMD64
and ARM64 against a fake local model provider: authenticated readiness, model routing, streaming
and tools-off behavior. It uses no personal credentials or paid model calls.

- [Hermes Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker)
- [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [OpenClaw Docker](https://docs.openclaw.ai/install/docker)
- [OpenClaw OpenAI API](https://docs.openclaw.ai/gateway/openai-http-api)
