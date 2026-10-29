# Process inspector

System Monitor → Processes shows real host measurements. Selecting a row opens a detail panel
inside the same window. Right-click or Shift+F10 opens the row's menu. Enter and Space select a
focused row. The panel shows CPU, resident and virtual memory, threads, process state, parent PID,
start and sample timestamps, and the associated systemd service or Docker container when known.
Unavailable host fields are shown as unavailable rather than estimated. Non-Linux development
hosts use a read-only `ps` query and have no supervisor mapping.

`GET /api/system/processes/:pid?startedAt=<milliseconds>` requires `system:read`. PID and query
fields are strictly validated. The agent reads only bounded procfs files and symlinks and checks
process identity before and after collecting metadata. An exited or reused PID returns not found.
Command arguments, executable paths and working directories require `system:manage`; environment
variables are never read. No process metadata is added to audit details.

## Supervisor actions

Restart, Stop and (systemd only) Reload Configuration use the existing service/container action
APIs. Confirmation identifies the supervisor and explains that all of its processes are affected.
The matching `services:read`/`services:manage` or `docker:read`/`docker:manage` permissions are
required. Existing server authorization, agent policy, audit events, protected units/containers,
and development-mode restrictions remain in force. Subprocesses in Docker are mapped to their
container, never to the Docker daemon's service.

Independent processes and user-session scopes have no control actions. EveryOS never reconstructs
an executable from a command line, replays arbitrary arguments, or sends raw PID signals. The panel
explains why these controls are unavailable. Stale responses from a previous selection cannot
enable another process's controls.

## Assistant explanations

Users with `apps:manage` and `terminal:access` can select a configured, ready local model, Hermes
Agent or OpenClaw. The initial choice prefers the local model. It stays selected during an answer
even if the assistant becomes busy. An explicit Explain click sends a bounded metadata snapshot
through the existing authenticated conversation and streaming-chat APIs; opening a row sends no
AI message. The resulting explanation stays in the panel and in that user's AI Chat history.
Requests can be cancelled and end when the inspector closes or the session locks.

The snapshot includes the PID, name, parent PID, state, measurements, timestamps and supervisor
identity. It excludes command arguments, filesystem paths, account names and environment data.
The prompt treats process metadata as untrusted data, asks for observations to be distinguished
from inferences, and requests an explanation without running tools or actions. The assistant's
existing connection determines where the snapshot is sent; no model server or agent is installed
automatically. Provider errors remain visible, and no ready provider produces an explicit empty
state. Test providers and status fixtures are marked `source: "simulated"`.

Turkish and English inspector strings are complete. Other interface languages retain their
existing process translations and use English for the new inspector copy.
