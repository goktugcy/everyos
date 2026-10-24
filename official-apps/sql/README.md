# SQL Client

Use the person's approved PostgreSQL or MySQL/MariaDB connections through EveryOS's secured
`db.*` connector. Administrators save connections in the App Store. Database credentials remain
sealed on the server and never reach the app. The app declares `database:connect`, `storage:app`
and `files:save` only.

The CodeMirror editor uses the selected engine's dialect. The table/view browser lists up to
2,000 reported objects, 100 per page, with column names, types and nullability. Choosing one
prepares a quoted SELECT without running it. A JSON array accepts up to 100 scalar parameters.
Limits default to 500 rows and 30 seconds, with server ceilings of 1,000 rows / 120 seconds.
Results have 100-row pages, source SQL, connection name, real elapsed time, read/write state,
row count and explicit truncation. CSV exports the complete returned snapshot, not just its
visible page; text formulas are neutralized and quotes/newlines are escaped.

Queries default to read only even on writable connections. A write needs an explicit app choice,
a writable connection and the desktop's own confirmation. The desktop displays the complete
validated statement, including statements beyond 20,000 characters. Connection changes, suspend
and history replay reset the app's write choice. The server's database privileges and policy still
apply. There is no arbitrary host command or client-side database connection.

`preferences.v1` stores only a validated connection id and row/timeout limits. The last 30
successful statements can be replayed within this window; SQL, parameters, results and passwords
are never persisted. Replay clears parameters and write authorization. History is deliberately
session-only because SQL literals and results can contain sensitive information. Failed requests
retain the last successful result with its source statement. Revocation clears session data and
late responses cannot populate another connection's result.

Nine logic/interface tests cover validation, quoting, CSV, read-only defaults, real error details,
connection testing, transient history, suspend and revocation. The real-browser workflow uses an
owned disposable PostgreSQL database and a restricted login: read-only rejection, declined and
approved native writes, full long-statement confirmation, CSV, close/reopen and 390-pixel layout.
All 39 locale keys are supplied in ten languages.

```bash
pnpm exec vitest run --project official-apps official-apps/sql
```
