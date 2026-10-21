# Databases for desktop apps

Apps holding `database:connect` (an elevated capability only administrators approve) run SQL on
databases an administrator connected in EveryOS: PostgreSQL, and MySQL or MariaDB. The app names a
connection; EveryOS connects on the server. Credentials are typed into EveryOS, sealed with the
server secret and never sent to an app, listed by the API or written to the audit log.

## Connections

Administrators (`settings:manage`) manage them in the App Store: under **Catalog sources →
Databases for apps** for all apps, or on an installed app's page for that app. Each connection has:

| Field          | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| Database       | PostgreSQL, or MySQL / MariaDB                                               |
| Host, port     | where it runs; link-local and cloud metadata addresses are refused           |
| Database, user | what to open, as whom                                                        |
| Password       | sealed on the server; editing keeps it unless a new one is typed             |
| Encryption     | encrypted, encrypted with the certificate and name checked, or not encrypted |
| Access         | read only (default), or read and change                                      |
| Who may use it | administrators only (default), or everyone who can use the app               |
| Applies to     | one app, or every app holding `database:connect`                             |

People who manage apps (`apps:manage`) can read the list (never a password). **Test** connects and
shows the server's version. Creating, changing and removing connections is audited.

## Operations

All are reached with `app.host.call(operation, input)`; types and `DB_LIMITS` come from
`@everyos/app-sdk`.

- `db.connections` → the connections this app may use for this person (id, name, engine, host,
  port, database, access).
- `db.test` `{ connection }` → `{ version, ms }`.
- `db.tables` `{ connection }` → tables and views with their columns (PostgreSQL: every schema but
  the system ones; MySQL: the connection's database), at most 2,000 tables.
- `db.query` `{ connection, sql, params?, maxRows?, timeoutMs?, write? }` → columns (with type
  names), rows as arrays, the command, the row count, whether it was cut, and the time taken.

### How a statement runs

- On its own connection, closed afterwards, as **one statement**: PostgreSQL runs it through the
  extended protocol and MySQL without multi-statement support, so `SELECT 1; DELETE …` is refused.
  Parameters are `$1, $2 …` (PostgreSQL) or `?` (MySQL), up to 100.
- **Read-only by default.** PostgreSQL: inside `BEGIN READ ONLY`, after a first query that fixes
  the mode (a later `SET TRANSACTION READ WRITE` is refused), rolled back at the end. MySQL: the
  session is `READ ONLY` (which also covers DDL's own transactions) inside
  `START TRANSACTION READ ONLY`. A change fails with `DESKTOP_APP_DB_READ_ONLY`.
- **Writing** needs both: a connection whose access is _read and change_, and `write: true`, which
  makes the desktop show the statement in a dialog it draws itself (_EveryOS asks for …_) before
  the server runs it. The app cannot answer that dialog or skip it: the server only accepts a
  write the desktop marked as confirmed. Widgets cannot write. Every write attempt is audited with
  the connection, the command, the row count and the statement's SHA-256, never its text.
- At most `maxRows` rows (≤ 1,000; 500 by default) and about 4 MiB of JSON; then `truncated`.
  Long text is cut at 65,536 characters. Statements stop after `timeoutMs` (1–120 s, 30 s by
  default), on the server (`statement_timeout`, `max_execution_time` or `max_statement_time`)
  and on EveryOS's side.
- Values are JSON: numbers; big integers, decimals, dates, times and intervals as text exactly as
  the database writes them; JSON columns as JSON; binary data as `\x` and hex.
- MySQL connections never allow `LOAD DATA LOCAL INFILE`: a server cannot make EveryOS read its
  files.
- Per app and person: 60 operations per minute; per person: 2 at once.

### What read-only does not cover

A read-only transaction stops the database from changing tables, but a powerful database account
can still call functions that act outside the transaction (for example ending other sessions).
**Give EveryOS a database user with only the privileges it needs**: for read-only connections, a
user that can only `SELECT`. The database's own privileges always apply on top (a `DELETE` by a
read-only user fails with the database's permission error).

## Errors

| Code                       | Meaning                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `FORBIDDEN`                | no `database:connect`, or a write without the person's confirmation     |
| `NOT_FOUND`                | the connection does not exist, or is not for this app or person         |
| `DESKTOP_APP_DB_READ_ONLY` | the statement would change data on a read-only run                      |
| `DESKTOP_APP_DB_FAILED`    | the database refused or failed; `details: { code, message, position? }` |
| `RATE_LIMITED`             | the per-minute or concurrent budget is spent                            |

`details.code` is the database's own code (a PostgreSQL SQLSTATE such as `42601`, or a MySQL
`ER_…` name), so an app can explain errors precisely.

## SQLite

SQLite files are files: an app opens one the person picks (`files:pick`) and reads it in the
browser (for example with SQLite compiled to WebAssembly), and saves changes back only through
`files:save`. No server connector is involved.
