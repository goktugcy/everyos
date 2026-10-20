# Menu bar and pulse

The desktop's menu bar follows macOS, without a background: items sit directly on the wallpaper
(a soft shadow, or a light halo in light themes, keeps them legible). On the left are the EveryOS
logo menu and the focused app's name in bold; on the right, monochrome status items (widgets,
notifications, resources, network, agent, desktops, search, quick settings) and the clock as
"Paz 11 Eki 14:33". Windows use macOS "traffic lights" on the left with a centered title; desktop
icon labels have no plate, only a legibility halo.

## The pulse

In the middle of the menu bar sits a 34 × 5 dot matrix, the **pulse**. It is part of the desktop
shell only (not the mobile shell) and is hidden below 1100 px of width. It stays in the free space
between the menu bar's left items (logo, app name, connection) and its right modules: centred when
it fits there, moved aside when long app names or many modules take the middle, and hidden only
when it does not fit at all.

What the dots show:

- **The server's heartbeat:** the last 34 CPU readings from the live metrics stream (about one
  per 1.5 seconds), drawn as lit columns from the bottom, newest on the right. A fully loaded
  column has a warning-colored top dot. Users without `system:read` see a slow shimmer instead.
- **Running jobs:** while a backup, restore or package update runs, a band of accent light sweeps
  across the dots (jobs are polled every 15 s, every 2 s while one runs, only when the tab is
  visible and the user may see them).
- **Unread notifications:** an accent dot at the right edge (live, no polling).
- **Dragged files:** anywhere on the desktop, the dots turn into blinking arrows; dropping onto
  the pulse opens the shelf. The pulse follows drags while events capture, so a drop taken by a
  Files window or the desktop ends the arrows too, and a drag that stops sending `dragover` for
  0.4 s (Esc, leaving the window) ends them as well.
- **Files on the move** ([transfers.md](transfers.md)): the bottom two rows become a progress bar
  filling from the left (its leading column blinks); right above it the pill shows the direction,
  how much has moved, the total and the speed ("↑ 12,4 MB / 48 MB · 3,2 MB/sn"). Transfers of
  unknown size sweep a light through the bar instead. The tooltip names the file or the count,
  the speed and the time left. When everything has finished, the heartbeat returns.
- **Disks coming and going:** for five seconds the pill shows **New disk connected** or **Disk
  removed** with the disk's name (two lines, the pill keeps its size), whatever the dots were
  showing ([disks.md](disks.md)). Several disks at once are named as "first +n".

Dragging wins over everything; then a disk message, transfers and the heartbeat.

Hovering the dots shows the current state as a tooltip. Reduced motion and the Performance render
mode stop the animations.

### The panel

Hover (after a short delay, if "Open on hover" is on) or click opens a glass panel below the menu
bar. A panel opened by hover closes when the pointer leaves; one opened by click stays until
Escape or a click elsewhere. The context menu of the dots jumps to a tab, opens the settings, or
hides the pulse. Hiding: the eye button in the panel, the context menu, Quick settings ("Menu bar
pulse") or Settings › Desktop › Pulse. The `pulse` preference document stores this per user.

**Dashboard**

- **Calendar:** the current month (weeks start on the locale's first day, Monday in Turkish),
  with dots on days that have scheduled task runs. Selecting a day lists its runs; they come
  from `GET /api/tasks/calendar?from=&to=` (`tasks:manage`), which evaluates the cron schedules
  in the server's local time and returns the first 200 runs plus a count per day. Ranges are
  limited to 62 days.
- **System:** live CPU, memory and temperature (`system:read`).
- **Activity:** running backup/restore jobs (`GET /api/backups/job`, `backups:manage`) and
  package updates (`GET /api/updates/jobs`, `system:read`), each opening its app.

**Transfers**

The same list as the menu bar's storage item: running and finished transfers with progress, speed,
time left and a stop button, the plugged-in disks (open, mount, eject) and Google Drive. The tab
shows the number of running transfers; the dots' context menu opens it.

**Shelf**

The shelf lists up to 48 items in the `pulse` preference, so it follows the user to other
browsers. It holds two kinds of item:

- **From the computer:** dropped files are uploaded through the normal file API (`files:write`)
  into a hidden folder of the user's home, `.everyos-shelf`, where they wait temporarily. A taken
  name is never overwritten; the file gets a number instead ("rapor (2).pdf"). Folders cannot be
  uploaded from a browser, and without a home folder nothing can be dropped from the computer.
- **From a Files window:** dragged items are only referenced (their type and size are read with
  `files/properties`); removing them from the shelf never touches the file.
- **Out of the shelf:** items drag into any Files window folder or the desktop; that place's rules
  apply (move by default, copy with Alt/Ctrl), and a moved item leaves the shelf. A waiting file
  that is moved becomes an ordinary file there. In Chrome and Edge, dragging a file out of the
  browser saves it to the computer. Each item can also be downloaded, and referenced items can be
  shown in Files.
- **Deleting waiting files:** removing a waiting file from the shelf (or clearing the shelf)
  deletes it for good with `POST /files/shelf/discard`; it never goes to the trash. Dragged out of
  the browser, its download URL carries `discard=true`: the server deletes the file once the
  browser has downloaded all of it. Only the server knows whether that happened (browsers report
  drops outside the page differently, and Firefox and Safari save nothing), so the shelf looks
  again 2, 10 and 60 seconds after such a drag and drops the item once its file is gone. A waiting
  file moved to a Linux location leaves no copy in the trash either.
- **Tidying:** whenever the shelf is shown and after file changes in the tab it calls
  `POST /files/shelf/tidy`. The server deletes files in `.everyos-shelf` that the stored shelf has
  not listed for an hour (a failed removal, a tab closed mid-upload) and returns the files left;
  the shelf drops waiting items whose file is gone.

`.everyos-shelf` is left out of file search and of home backups, so deleted waiting files do not
live on there.

Every file operation goes through the same API and permission checks as the Files app; the
shelf needs `files:read` to appear.
