# Transfers

Everything that moves files for a while is listed with its progress, speed and time left: uploads
from the browser and copies that run on the server between [Google Drive](drive.md) and EveryOS
locations.

## Where it shows

- **Pulse** ([pulse.md](pulse.md)): while files move, the dots become a progress bar filling from
  the left with an arrow for the direction (up, down or both); a sweeping light marks transfers of
  unknown size. The tooltip names the file (or the count), the speed and the time left. The
  panel's **Transfers** tab lists everything. A disk that is plugged in or removed is named in the
  pill for five seconds.
- **Menu bar:** the storage item (Settings › Desktop › menu bar modules, "Storage and transfers")
  shows a progress ring around its icon, and the speed next to it when the pulse is hidden. It
  takes no room while nothing is plugged in, connected or moving. Its panel lists transfers,
  plugged-in disks (open, mount, eject) and Google Drive.
- **Dock:** a shelf item at the end of the dock, like a downloads stack, while something is listed
  or a disk is plugged in: a badge with the number of running transfers and a progress bar.
- **Files:** the status bar of an uploading window shows the speed and time left.
- **Phones:** a ring button in the header opens the same panel.

Every running transfer can be stopped from the lists; **Clear finished** forgets finished ones.

## Speed and time left

Progress is sampled twice a second. The speed is smoothed (70 % of the previous value, 30 % of the
latest sample), the time left is the remaining bytes at that speed. Speeds use decimal units
("12.4 MB/s"); sizes use the binary units the rest of EveryOS uses. A folder is counted before it
is copied, so its total and time left are known; a copy that contains Google Docs files (exported
on the fly) has no total and shows the sweep instead.

## Browser uploads

Uploads from Files, the desktop and the pulse shelf register themselves in the tab's list with
their XHR progress. Only that browser tab sees them; closing it stops them.

## Server transfers

`TransferService` (API) runs copies for each person: at most two at a time per person, the rest
queued; the last 20 finished ones are kept for the list. Jobs live in memory, so an API restart
ends them (a restart or shutdown from EveryOS lists running transfers as a blocker that can be
overridden). A transfer that ran for 20 seconds or more, or failed, ends with a personal
notification (`transfer-succeeded`, `transfer-failed`). Failures carry an error code
(`DRIVE_QUOTA_EXCEEDED`, `FILES_INSUFFICIENT_SPACE`, `CANCELLED`…).

Transfers use the person's own file view, the same one as Files: their home, the configured
locations and the mounted disks, written as the linked Linux account in production. Each file
operation is counted as file access, so a home backup or restore waits for it.

## API and events

| Method & path                  | Permission   | Description                                                      |
| ------------------------------ | ------------ | ---------------------------------------------------------------- |
| `GET /transfers`               | `files:read` | `{ transfers }`, the caller's own, newest first.                 |
| `POST /transfers/:id/cancel`   | `files:read` | Stops a queued or running transfer.                              |
| `DELETE /transfers`            | `files:read` | Forgets finished transfers.                                      |
| `GET /events?topics=transfers` | `files:read` | `transfers` with the caller's list, at most four times a second. |

Transfers are started by the module that moves the files, e.g. `POST /drive/transfers`.
