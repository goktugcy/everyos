EveryOS 0.1.40 fixes process explanations in System Monitor.

- A running assistant stays listed while it is busy. Starting an explanation no longer shows a
  false missing-connection message. Initial connection loading and actual unavailable states
  remain distinct, and the selected model is visible in the inspector.
- Explanations focus on the selected process's name, PID and usual purpose before interpreting
  its resource use and service/container association. Each click reads a fresh process snapshot
  and starts an isolated diagnostic request, instead of continuing a general assistant chat.
- Hermes Agent, OpenClaw and direct local models receive the same process-specific task context.
  General chat history and local chat personas no longer dilute the diagnostic request. Local
  explanations use the interface language and a sufficient answer budget for a detailed response.
- Private command arguments, account names, filesystem paths and environment variables are
  excluded. Exited or reused processes, connection errors, cancellation and session locks remain
  visible and enforced. Diagnostic requests do not fill the assistant's chat history.
- The five standalone SDK packages advance together to 1.0.3 for this core release. The official
  catalog retains all 29 applications.
