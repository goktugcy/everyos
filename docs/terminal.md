# Browser terminal (Phase 7.3)

The lazy `everyos.terminal` desktop app connects to a real agent pseudo-terminal through the
same-origin API WebSocket. Each window has its own shell. The browser cannot select an account,
choose a shell, or run a command through an HTTP execution endpoint.

## Configuration and identity

Production is disabled until the owner configures an existing, regular system account in
`/etc/everyos/agent.yaml` and restarts the agent:

```yaml
terminal:
  user: server-operator
  # shell: /bin/bash       # optional; defaults to the account's login shell
  # python: /usr/bin/python3
```

Python 3 provides the PTY; the interpreter and shell must exist at absolute paths. The agent
resolves the account, drops UID/GID and supplementary groups before starting the shell, and uses
its home directory and a fixed environment. The UI shows the actual account and shell from the
server's `ready` frame. All EveryOS administrators use the configured system identity, rather than
an operating-system account derived from their EveryOS username.

Root is refused by default. `allowRoot: true` is an explicit owner-only configuration escape
hatch; the client never offers it. Prefer a dedicated account with only the host access it needs.
The shell has that account's ordinary OS permissions: it is not a sandbox, and interactive
commands do not go through EveryOS's service/container operation safeguards. Its ability to use
`sudo` or other installed tools is determined by the host's account policy.

In development, `EVERYOS_DEV_TERMINAL=1 pnpm dev` enables a real PTY as the developer's own
unprivileged account. The e2e stack enables this flag in its disposable state directory. This is
not a terminal simulator and does not grant root access.

Disabled status reasons are `not-configured`, `user-missing`, `root-refused`, and
`python-missing`. The app localizes each reason and shows how to configure `terminal.user`.

## Authorization and bounds

- `terminal:access` is administrator-only. Registry filtering hides the app from other roles;
  the API and agent enforce authorization independently.
- The API authenticates the WebSocket with the session cookie. Upgrades require a matching
  `Origin` (or a configured public origin) and an unlocked, enabled user with the permission.
  Origin checks prevent cross-site WebSocket hijacking; HTTP deletion also requires CSRF.
- Every 15 seconds the gateway revalidates the session, lock state, account and permission.
  Revoked access ends the shell. Reconnection probes the ordinary protected status endpoint,
  so HTTP 401/403/423 also stops retries and invokes the client's session handling.
- Limits are four sessions per user and twelve overall, with a 30-minute input idle timeout.
- A dropped connection has a 60-second reconnect grace period. The API retains at most 256 KiB
  of output for replay. A newer attachment replaces the older socket.
- Opening and closing write audit events with actor, system account, session ID, outcome and
  close reason. Keystrokes and shell output are not audited or persisted by EveryOS; output can
  contain secrets. The configured shell may maintain its own history.

## HTTP and WebSocket protocol

All paths below include the `/api` prefix:

| Endpoint                                          | Result                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /terminal/status`                            | `{ enabled: true, user, shell }` or `{ enabled: false, reason }`                |
| `GET /terminal/sessions`                          | `{ sessions: TerminalSessionView[] }`; own sessions, or all with `users:manage` |
| `DELETE /terminal/sessions/:id`                   | End an owned session (or any with `users:manage`); `204`                        |
| `GET /terminal/ws?cols=80&rows=24&session=<uuid>` | WebSocket upgrade; omit `session` for a new shell                               |

Client keystrokes/paste are UTF-8 **binary** frames, each at most 64 KiB. Client controls are
JSON **text** frames: `{ "type": "resize", "cols": 80, "rows": 24 }`. Columns range from 2 to
500, rows from 2 to 300. Output arrives as binary frames and is passed to xterm as bytes, so
UTF-8 decoding works across frame boundaries. Server text frames are:

```json
{ "type": "ready", "sessionId": "<uuid>", "account": "server-operator", "shell": "/bin/bash", "resumed": false }
{ "type": "exit", "reason": "exited", "code": 0 }
```

Exit reasons: `exited`, `idle`, `closed`, `revoked`, `error`; `code` can be `null`.
Final close codes: `4000` ended, `4403` disabled/agent unavailable, `4404` session missing,
`4409` opened elsewhere, `4429` session limit. The app localizes them and offers an explicit
new-session action. It never automatically creates a replacement after a final close or exit.

## Client lifecycle

Unexpected drops retry with exponential delays from 500 ms up to 5 seconds, stopping before
55 seconds. Retries carry the same session ID. Before replay the local terminal is reset so
output is not duplicated. Only the bounded server replay is recoverable; a full terminal screen
or history beyond that buffer is not guaranteed after a long output stream.

The session ID is stored in `sessionStorage`, scoped by user and window, so a page reload can
reattach within the grace period. IDs are not stored in synchronized desktop preferences. If
browser storage is unavailable, reconnect works in memory, but reload cannot resume that shell.

Closing a window sends a CSRF-authenticated DELETE with `keepalive: true` and closes its socket.
The socket also uses close code `4000` to signal explicit closure if the `ready` frame has not
delivered an ID yet. The API refuses to create a shell on an already closed socket and checks
quotas again after the asynchronous agent status request, preventing concurrent openings from
exceeding limits.
Page navigation/reload only detaches, preserving the reconnect grace. Sign-out ends the tab's
shells before revoking the browser session. If the network prevents deletion, server grace/idle
and permission checks still bound the shell's lifetime.

The sessions dialog filters to the current user's sessions and allows ending detached shells
through the desktop confirmation dialog. Attached shells are closed through their own windows.

ResizeObserver and the fit addon track window size; resize controls are debounced by 100 ms and
clamped to protocol limits. Font, font scaling and colors come from existing CSS tokens and
update with every theme. Native clipboard shortcuts work; reserved desktop shortcuts (including
Ctrl/Cmd+K and Ctrl+Alt window commands) remain available while terminal input is focused.
Other input goes to the shell. Observers, subscriptions, resize/reconnect
timers, xterm and the socket are disposed when the app unmounts.

## Verification

Pure helper and connection tests exercise final close decisions, backoff, sizing/debounce,
protocol frames and binary paste bounds. `tests/e2e/tools-terminal.spec.ts` exercises the real
PTY through the built API and agent, including output, reload/reattach, closing and viewer denial.
Run `pnpm check`, `pnpm build`, then `pnpm test:e2e`.
