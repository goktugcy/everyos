# Docker management

Phase 4 implements Docker Engine management through the agent and an API-backed desktop/mobile
application. The API never accesses the Docker socket. Runtime schemas and the operation registry
validate requests/results; permissions are enforced in both the API and agent.

## Ownership and lifecycle

| Ownership | Source                                    | Behavior                                                                                         |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| External  | Discovery without an Otuken record        | Inspect, logs/stats and explicit container start/stop/restart. No Compose actions before import. |
| Imported  | Owner-authorized Compose import in SQLite | Container controls plus project up/start/stop/restart/update/down with validated host files.     |
| Managed   | Reserved for the Phase 5 installer        | No Phase 4 action creates this ownership. Labels cannot grant it.                                |

The Compose view groups discovered services and hints at CasaOS, Coolify, Runtipi or Portainer
management. Import requires acknowledgment of another manager hint and validates absolute
normalized YAML paths, regular files, size and a services mapping. Importing/removing an import
changes only Otuken records. Imported projects remain visible after down and can be started with
up from their recorded paths.

Container stop/restart and Compose stop/restart/update/down require UI confirmation. Protected
containers accept only start, including through Compose. Down preserves named volumes/images;
update pulls before recreating and stops if the pull fails. Actions report/audit the real outcome.
No automatic prune or container deletion exists.

Unused images/networks have explicit deletion controls. Built-in networks and resources referenced
by any container (including stopped ones) cannot be deleted. Volume deletion requires admin-only
`docker:delete` and the exact name typed back; it permanently removes data. Docker performs the
final conflict check, and deletions never use force.

## Live data and errors

- Detail exposes environment names, ports, mounts, limits, health and isolation risks. Viewers
  cannot see command/entrypoint; sensitive label names are masked. Logs require `logs:read`.
- One-shot counters are sampled every 5 s while subscribed; the API derives CPU, network and
  block-I/O rates. Missing counters remain null; counter resets do not yield negative rates.
  Docker's host-memory value for an unlimited container is not displayed as a limit.
- History is bounded to 15 minutes and 300 containers, in memory only. Two samples are needed
  before a CPU/rate line exists. History resets on API restart.
- The shared per-tab SSE connection carries metrics and Docker topics. Lifecycle events trigger
  debounced inventory refreshes. Healthcheck exec events are excluded.
- Logs support backlog/follow, demultiplex stdout/stderr, preserve UTF-8 across frames, strip
  terminal control text and bound displayed lines. Stream failures show an error and retry action.
- Development uses labeled simulated Docker if no socket exists or simulation is enabled. With a
  real socket, development is read-only. Production never simulates missing data.

## Verification

Unit/integration tests cover parsing, fake Unix-socket version negotiation/streaming, UTF-8 framing,
file checks, exact Compose arguments/socket binding, cancellation, permissions, strict HTTP input,
container/project protection, ownership, deletion conflicts and audit. Playwright exercises the
built app with a labeled simulator: charts/logs, confirmations, import/down/up, volume name
confirmation and stream error recovery.

Verified on 2026-10-10 on the owner's Raspberry Pi 5 using Node.js 22.23.3, Docker 29.7.2 (API
1.55), Compose 5.4.0 and 11 running containers. A fresh temporary development agent/API pair ran
unprivileged on a separate loopback port. All seven Docker inventory/status/stats endpoints and
container detail/logs returned 200 with host data; read latencies were 16–122 ms in this single run.
The development mutation guard returned 403 for a nonexistent container, and the API returned 409
for an external project's Compose action. No real Docker resource was changed or imported.

| Measurement                                      | Agent    | API       |
| ------------------------------------------------ | -------- | --------- |
| Idle RSS after 15 s                              | 86.2 MiB | 102.3 MiB |
| Idle CPU, one core                               | 0.3%     | 0.1%      |
| Live RSS after 20 s, Docker + metrics subscribed | 92.0 MiB | 89.4 MiB  |
| Live CPU, one core                               | 1.2%     | 0.9%      |
| Peak RSS during this run, including setup        | 96.0 MiB | 160.8 MiB |

The 20-second live interval produced 5 Docker snapshots and 10 host metrics snapshots, with CPU
rates for all 11 containers. None had a configured memory limit; all were correctly shown without
a limit. These are short local measurements with Node.js 22, not production/Node.js 26 benchmarks.
Only the verifier's own processes and newly created temporary state were removed afterward.

Production root-agent operation, real lifecycle/deletion/Compose mutations, root-only file access
and disposable-host rollback still require dedicated acceptance; they were not tested on the
owner's live containers. App Store installation/managed ownership is Phase 5. Root service
packaging/hardening is Phase 8.
