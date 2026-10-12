EveryOS 0.1.4 fixes package-update job state and makes preflight failures visible.

- Package refreshes and upgrades release the action buttons after success, failure or interruption.
  Starting requests cannot be submitted twice. Jobs remain tracked while the History or EveryOS
  tab is selected, and persisted-status polling recovers from a lost live-log connection.
- The live view and history explain missing Linux account links, expired sudo authorization,
  agent failures and APT failures. Errors before APT starts now have a diagnostic log entry.
- A sudo denial offers **Verify sudo access** directly in Updates. It uses the same PAM and
  session-scoped sudo flow as Settings → Account; the administrator explicitly retries afterward.
  Linking a Linux account alone does not grant root package-management rights.
- APT preflight command failures retain bounded diagnostics. Only installed packages are upgraded,
  removals remain blocked, existing configuration files are kept and EveryOS itself still uses the
  independently signed release workflow.

The update source remains `https://github.com/goktugcy/everyos/releases` with the existing publisher
key. Network settings, Linux account associations, personal files and wallpapers are preserved.
