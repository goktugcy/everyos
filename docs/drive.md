# Google Drive

Every EveryOS user can connect their own Google Drive. Connected people browse it in Files, upload
files from their computer, download files, and copy files and folders between Drive and EveryOS
locations (home, locations, disks) as [transfers](transfers.md) with live progress. Bytes never go
from the browser to Google directly: EveryOS streams them.

## Setting up the Google client (once, by an administrator)

EveryOS ships no shared Google credentials. Google requires a security assessment before an app
may offer full Drive access to the public, so each server owner registers their own OAuth client,
used only by the people of their server. Settings › Connections › **Google Drive client** shows
these steps:

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com).
2. Under APIs & Services › Library, enable the **Google Drive API**.
3. Under Google Auth Platform › Branding, enter an app name and an e-mail; under Audience, choose
   the **External** user type.
4. Under Data access, add the `https://www.googleapis.com/auth/drive` scope.
5. Under Audience, **Publish app** (In production). While an External app is in Testing, Google
   expires its refresh tokens after 7 days. An unpublished, unverified app shows a warning on the
   consent page; the owner continues with "Advanced › Go to … (unsafe)".
6. Under Clients, create a client of type **Desktop app**, then paste its client ID and secret into
   EveryOS.

The client secret is sealed with SecretBox (`drive:client:secret:v1`) in the `instance_settings`
table and never returned. Saving the same client ID without a secret keeps the stored one; a new
client ID needs its secret and disconnects everyone (tokens belong to the client that issued
them). **Remove client** disconnects everyone too.

## Connecting a Drive

Settings › Connections › **Your Google Drive** › **Connect Google Drive** asks the API for a
consent address. The API generates the `state` and a PKCE verifier (S256), keeps them in memory
for ten minutes for that person only, and asks Google for `access_type=offline` and
`prompt=consent`, so a refresh token always comes back. The consent page opens in a new tab.

Desktop app clients may only send the browser back to a loopback address:

- **The browser runs on the server** (EveryOS opened at `http://127.0.0.1` or `localhost`): Google
  returns to EveryOS itself, and the shell finishes connecting and opens Settings › Connections.
- **Anywhere else:** Google returns to `http://127.0.0.1:53682/`, where nothing listens on the
  person's computer. The page says the site cannot be reached; the person copies its address and
  pastes it into EveryOS, which reads `code` and `state` from it. The code is useless without the
  verifier that only the server holds.

The API exchanges the code (with the client secret and the verifier), checks that the Drive scope
was granted, reads the account's e-mail address and name, and stores the refresh token sealed per
person (`drive:<user id>:token:v1`) in `drive_accounts`. Access tokens live only in memory and are
refreshed a minute before they expire, one refresh at a time per person.

When Google refuses the refresh token (`invalid_grant`: revoked, expired in Testing, or issued for
another client), the account is marked **reconnect**; requests answer `DRIVE_RECONNECT_REQUIRED`
and Settings, Files and the storage panel offer **Connect again**. **Disconnect** revokes the
token at Google (best effort) and deletes it.

## Files

A connected Drive appears in the Files sidebar under **Cloud**. Not connected yet, the entry opens
Settings › Connections.

- **My Drive** and **Shared with me**, with breadcrumbs from My Drive (or Shared with me) to the
  folder. Shortcuts show their targets. Lists come 200 at a time (**Show more**).
- **Open** a folder; **Download to this computer** streams a file through EveryOS. Google Docs,
  Sheets, Slides and Drawings are exported as `.docx`, `.xlsx`, `.pptx` and `.png`; other
  Google-only files (Forms, Sites…) cannot be downloaded.
- **Upload from this computer** (button or drop): the browser sends the file to EveryOS, which
  streams it into a resumable Drive upload. It is listed as a transfer with its speed.
- **Copy to EveryOS…** picks a writable folder (home, locations, disks) and starts a transfer.
  Dropping items from a Files window onto the Drive folder copies them to Drive.
- In Files, **Send to Google Drive…** on local files and folders picks a My Drive folder and starts
  a transfer.
- **New folder**, **Rename** and **Move to Drive trash** (restorable from Google Drive for 30
  days). Nothing is deleted permanently.

Copies never overwrite: a taken name gets a number in EveryOS ("rapor (2).pdf"); Drive allows equal
names. Drive folders with equal names keep their own contents. Folder copies are bounded like
local ones: at most 10,000 items and 16 levels.

## Security

- Google is reached only at its fixed endpoints (`oauth2.googleapis.com`, `www.googleapis.com`);
  DNS is resolved once and pinned, only public addresses are used, redirects are never followed,
  and resumable upload sessions must stay on the API host.
- The full `drive` scope is asked for because people browse their existing files; EveryOS acts only
  on what the person does in the interface.
- Tokens and the client secret never reach a browser; audit entries (`drive.client.*`,
  `drive.account.*`, `drive.upload`, `drive.download`) carry no secrets.
- Personal: each person sees only their own Drive. Transfers run with the person's own file
  permissions; in production EveryOS locations are written as the linked Linux account.

## Permissions

| Action                               | Permission      |
| ------------------------------------ | --------------- |
| Register or remove the Google client | `system:manage` |
| Connect, browse, download            | `files:read`    |
| Upload, copy, rename, trash, folders | `files:write`   |

## API

| Method & path                         | Description                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET/PUT/DELETE /drive/client`        | The client: `{configured, clientId}`; `PUT {clientId, clientSecret?}`; `DELETE {confirm: true}`. |
| `GET /drive/account`                  | `{configured, account: {email, name, status, quota, connectedAt} \| null}`.                      |
| `POST /drive/connect`                 | `{redirectUri}` (a loopback address) → `{url}` of the consent page.                              |
| `POST /drive/connect/complete`        | `{code, state}` → the account.                                                                   |
| `DELETE /drive/account`               | Disconnect.                                                                                      |
| `GET /drive/files?folder=&pageToken=` | `folder` = `root`, `shared` or a folder id → `{folder, path, entries, nextPageToken}`.           |
| `POST /drive/folders`                 | `{parent, name}`.                                                                                |
| `PATCH /drive/files/:id`              | `{name}`.                                                                                        |
| `POST /drive/files/:id/trash`         | `{}`.                                                                                            |
| `GET /drive/files/:id/download`       | The file as an attachment.                                                                       |
| `POST /drive/upload?parent=&name=`    | Raw body with `Content-Length` → the new entry.                                                  |
| `POST /drive/transfers`               | `{source, destination}`: Drive → a files folder or files → a Drive folder → `202` transfer.      |

In development, `EVERYOS_DEV_FAKE_GOOGLE=1` starts an in-memory stand-in for Google's OAuth and
Drive endpoints inside the API (consent is approved at once); the browser tests use it. Production
ignores the variable.
