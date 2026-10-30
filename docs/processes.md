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
variables are never read. Diagnostic audit details contain only the requested PID and outcome.

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
Agent or OpenClaw. Initial status loading is distinct from having no configured connection. The
initial choice prefers an idle local model. A running, busy assistant stays listed and selected;
its own pending explanation never produces the missing-connection message. The model chip shows
the current model and allows an explicit switch while idle.

An Explain click posts only PID, optional start time and interface locale to
`POST /api/ai-agents/:kind/process-explanation`. The endpoint additionally requires `system:read`,
strictly validates its input and reads a fresh process snapshot through the existing validated
`processes.get` operation. Client-supplied process descriptions and prompts are rejected. Opening
a row sends no AI message. Requests can be cancelled and end when the inspector closes or the
session locks; permissions are rechecked during streaming.

Each explanation is a separate diagnostic turn with a process-specific system message and one
user message. It neither loads nor writes general conversation history and does not consume its
conversation quota. A unique upstream user identifier separates gateway sessions. The task starts
with the selected process's name, PID and usual purpose, then interprets measurements and supervisor
associations while identifying uncertainty. Local models receive a 1,200-token answer budget and
temperature 0.2; their general chat persona, short-answer setting and forced chat language do not
override this task. Other local sampling and context-window settings remain in effect. Ordinary
chats keep their existing behavior.

The snapshot includes the PID, name, parent PID, state, measurements, timestamps and supervisor
identity, plus the executable basename when authorized. Timestamps use ISO dates and resident
memory includes an explicit MiB value. It excludes command arguments, filesystem paths, account
names and environment data.
The prompt treats process metadata as untrusted data, asks for observations to be distinguished
from inferences, and requests an explanation without running tools or actions. The assistant's
existing connection determines where the snapshot is sent; no model server or agent is installed
automatically. Provider errors remain visible, and no ready provider produces an explicit empty
state. Busy and unavailable states remain distinct. Test providers and status fixtures are marked
`source: "simulated"`.

Gateway-specific permissions remain in force: a system message and `tool_choice: "none"` do not
replace an upstream agent's native tool policy. EveryOS exposes no action tools in this request.
Hermes layers client system messages over its own prompt; OpenClaw scopes its HTTP tool-choice
contract to client-supplied tools. See the [Hermes API server documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
and [OpenClaw chat API documentation](https://docs.openclaw.ai/gateway/openai-http-api).

Turkish and English inspector strings are complete. Other interface languages retain their
existing process translations and use English for the new inspector copy.
