# Widget platform (Phase 6)

Widgets show live host and application data on the desktop, in a right-hand sidebar and in the
menu bar. Every widget is **built in**: manifests live in `@otuken/widget-sdk`, renderers in
`apps/web/src/desktop/widgets/renderers`, and collection on the server. App Store catalogs can only
be matched to a built-in adapter. They never ship widget code, and no remote JavaScript is ever
loaded into the desktop.

```
browser tab ── one EventSource ──► /api/events?topics=metrics,data.storage,data.integration.<id>.sessions
                                      │
                         DataHub (API): one collector per topic, reference-counted,
                         cached last value, per-subscriber permission check and view
                           │                          │
                   agent operations           IntegrationService (safe HTTP client,
                   (procfs, systemd,          sealed credentials) ──► app APIs on the LAN
                    apt, Docker)
```

## 1. Manifests

`WidgetManifest` (`packages/widget-sdk/src/types.ts`, validated by `WidgetManifestSchema` in
`@otuken/shared/schemas`):

| Field                | Meaning                                                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`      | Always `1`.                                                                                                                                                                                                                                                                                                |
| `id`                 | `<provider>.<name>`, e.g. `system.cpu`, `jellyfin.sessions`. The i18n key is `widgets.items.<id with "." → "_">`.                                                                                                                                                                                          |
| `version`            | Configuration format version. Stored instances record it, and `migrateWidgets` normalizes older configurations on load. Unknown widgets are kept and shown with a "remove" action.                                                                                                                         |
| `provider`           | `system`, `docker`, `raspberryPi` or an integration adapter.                                                                                                                                                                                                                                               |
| `categories`         | Gallery filters: `system`, `storage`, `network`, `docker`, `raspberryPi`, `apps`.                                                                                                                                                                                                                          |
| `supportedSizes`     | `compact` (menu bar line), `small` 2×2, `medium` 4×2, `large` 4×4 cells. Desktop widgets can also be resized to `custom` (2×1 to 12×10).                                                                                                                                                                   |
| `placements`         | `desktop`, `sidebar`, `menubar`. The menu bar takes only widgets with a `compact` size.                                                                                                                                                                                                                    |
| `permissions`        | All are required to add the widget **and** to receive its data. The server enforces this per subscriber.                                                                                                                                                                                                   |
| `requiresCapability` | Host capability from `/api/system/info`. The gallery explains why it is unavailable instead of hiding it.                                                                                                                                                                                                  |
| `dataSources`        | Topics the widget reads. `{integration}` is replaced by the configured integration id.                                                                                                                                                                                                                     |
| `config`             | Declarative fields: `boolean`, `select`, `number` (min/max), `mount`, `integration` (adapter), `dockerTarget` (`app:`/`project:`/`container:`), `entities` (Home Assistant, `control`, `maxItems`). The configuration dialog and validation (`normalizeConfig`, `missingConfig`) are generated from these. |

The 44 built-in widgets cover the following:

- **System:** CPU, frequency, temperature, memory, swap, disk usage, disk I/O, mounts, network,
  interfaces, ports, connections, Tailscale, uptime, load, processes, fans, sensors, NVMe, APT,
  alerts, services and timers.
- **Raspberry Pi:** SoC temperature, throttling, under-voltage and model.
- **Docker:** summary, container resources, and one generic container/project/app widget.
- **Apps:** Jellyfin (status, sessions, library), Immich (status, storage, statistics), Home
  Assistant (entities, automations, quick controls), Uptime Kuma (monitors, incidents), Nextcloud
  (status, storage) and PostgreSQL (statistics).

A unit test checks that every manifest has a renderer and Turkish and English texts.

## 2. Layout document

Layouts are the per-user `widgets` preference document (`PUT /api/preferences/widgets`, validated
by `WidgetPreferencesSchema`):

```jsonc
{
  "version": 1,
  "sidebar": { "open": true },
  "instances": [
    {
      "id": "…",
      "widgetId": "system.cpu",
      "widgetVersion": 1,
      "placement": "desktop",
      "size": "medium",
      "custom": null,
      "position": { "col": 12, "row": 0 }, // desktop only
      "desktopId": "d…", // null = shown on every virtual desktop
      "order": 0, // sidebar and menu bar
      "opacity": 1, // 0.3–1, applied to the glass, never to the text
      "locked": false,
      "config": { "chart": true },
    },
  ],
}
```

The layout follows these rules:

- **Limits:** at most 64 instances.
- **Desktop grid:** desktop widgets snap to an 80 px grid inside the window work area. New widgets
  take the first free cell, scanning from the top right (icons fill from the left). A move or
  resize that overlaps another widget or leaves the grid is refused, and the widget snaps back
  with a short notice.
- **Shrinking work area:** when the work area shrinks (window resize, sidebar opened), widgets
  that no longer fit move inward to the nearest free cell (`effectiveCells`). The saved layout
  adopts those cells on the next layout change, so placement checks always match the screen.
- **Missing virtual desktop:** widgets on a desktop that no longer exists, or on a default
  desktop that was never saved, move to the first desktop (`reassignDesktops`), like windows.
- **Sidebar:** 320 px wide, below the menu bar and beside a right or bottom dock. While it is
  open, windows do not go underneath it (the work area shrinks).
- **Menu bar:** a module (`menubar.hidden` can include `widgets`) shows compact widgets and the
  sidebar toggle.

Users can perform these actions:

- **Placing:** add (gallery, desktop context menu, sidebar "+"), remove, duplicate, and move
  between placements.
- **Arranging:** drag by the header, use the arrow keys on the focusable move handle, resize with
  the corner handle, and reorder in the sidebar and menu bar.
- **Settings:** change the size, opacity and lock state, pin to all desktops, configure, and
  restore the default layout (Settings › Widgets).

## 3. Data topics

| Topic                          | Permission                     | Interval | Contents                                                                                       |
| ------------------------------ | ------------------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| `metrics` (stream topic)       | `system:read`                  | 2 s      | Existing `MetricsSnapshot` (CPU, memory incl. swap total, network, disk, temperatures, fans).  |
| `docker` (stream topic)        | `docker:read`                  | 5 s      | Existing container stats and change notifications.                                             |
| `data.system`                  | `system:read`                  | 5 min    | Hostname, model, OS, kernel, architecture, memory.                                             |
| `data.storage`                 | `system:read`                  | 30 s     | Mount usage.                                                                                   |
| `data.network`                 | `system:read`                  | 30 s     | Interfaces and addresses.                                                                      |
| `data.tailscale`               | `system:read`                  | 30 s     | Tailnet status.                                                                                |
| `data.hardware`                | `system:read`                  | 60 s     | Throttling flags, NVMe health.                                                                 |
| `data.processes`               | `system:read`                  | 5 s      | Total and top 10 by CPU and memory: pid, name, CPU, memory. **No command lines.**              |
| `data.services`                | `services:read`                | 30 s     | Totals and up to 20 failed units.                                                              |
| `data.timers`                  | `services:read`                | 60 s     | Up to 30 timers sorted by next run.                                                            |
| `data.sockets`                 | `system:read`                  | 30 s     | Up to 200 listening sockets (protocol, address, port, process name) and connection counts.     |
| `data.apt`                     | `system:read`                  | 30 min   | Upgradable package count, security count, 20 names. Package lists are **never refreshed**.     |
| `data.docker`                  | `docker:read`                  | 10 s     | Container states (no stats). Installed apps only for `apps:read`. Refreshed on Docker changes. |
| `data.alerts`                  | `system:read`                  | 30 s     | Current problems, each filtered by its own permission (failed services need `services:read`).  |
| `data.integration.<id>.<feed>` | `apps:read` or `apps:manage`\* | per feed | App feed (see §5).                                                                             |

\* `apps:read` when the integration's audience is `everyone`, `apps:manage` (the default) otherwise.

Every data message is a `TopicMessage`:

```ts
| { topic, at, status: "ok", data }
| { topic, at, status: "unavailable", reason } // not-linux, tool-missing, app-offline, auth-failed, not-configured, app-removed, …
| { topic, at, status: "error", code }         // FORBIDDEN, NOT_FOUND, RATE_LIMITED, UNSAFE_ADDRESS, INTERNAL_ERROR, …
```

**DataHub** (`apps/api/src/modules/widgets/data-hub.ts`) works as follows:

- A collector runs only while a topic has subscribers, however many widgets, tabs and users
  read it.
- A new subscriber immediately gets the cached last value.
- Failures back off exponentially, up to 5 minutes. A collection times out after 30 s.
- At most 256 distinct topics are active.
- Permissions are checked per subscriber. Providers can return a per-subscriber view, used for
  alerts and Docker apps.
- Changing or deleting an integration invalidates its topics. Current subscribers get a fresh
  collection, or `NOT_FOUND`.

**Client.** `useTopic` (`apps/web/src/desktop/widgets/topics.ts`) reference-counts topics on the
tab's single event stream and drops the cached value with the last reader. On the widget side:

- **Errors:** every widget renders inside its own error boundary. A failing widget shows
  "stopped unexpectedly" with a retry button, and the desktop keeps running.
- **No fabricated data:** unavailable or failed data is shown as a reason, never as invented
  values.
- **Simulated data:** data from development simulators is labeled "Simüle veri" (an icon on small
  tiles).

## 4. Application integrations

`POST /api/integrations` (`apps:manage`) is the administrator's explicit consent for Otuken to read
an app's API. Integrations are stored in the `integrations` table (migration 0007) as follows:

- **Credentials** are sealed with the secret box (context `integration:<id>:secret:v1`). They are
  write-only: views only say `hasCredentials`.
- **Audience** is `managers` by default, because app data can be private: who is watching what,
  who is home.
- **Linked app:** an integration can be linked to an installed app. If that app is uninstalled,
  its feeds report `app-removed`, and its widgets offer "configure" or "remove".

| Adapter        | Auth                                          | Feeds → data returned to the browser                                                                                     |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Jellyfin       | API key (`MediaBrowser Token`)                | `status` (public info), `sessions` (user, client, device, title, progress; **no client IPs**), `library` (counts).       |
| Immich         | API key (`x-api-key`)                         | `status`, `storage` (bytes), `statistics` (photos, videos, usage; needs an admin key).                                   |
| Home Assistant | Long-lived token (Bearer)                     | `states` (**only entities listed by the administrator**), `automations` (names, state, last triggered).                  |
| Uptime Kuma    | API key (basic auth on `/metrics`)            | `monitors` (name, type, status, response time; **monitor URLs/hostnames are never parsed**).                             |
| Nextcloud      | serverinfo token (`NC-Token`) or app password | `status` (`/status.php`), `serverinfo` (users, files, free space, active users).                                         |
| PostgreSQL     | none (local socket inside the container)      | `stats` via agent `apps.postgres.stats`: connections, max connections, database sizes. Container state when not running. |

**HTTP client** (`apps/api/src/modules/integrations/http.ts`):

- **Requests:** http(s) only, no credentials in URLs, at most 1 MB and 6 s per request.
- **Address checks:** DNS is resolved once and the connection pinned to the checked addresses.
  LAN and loopback are allowed (self-hosted apps live there). Link-local and cloud metadata
  addresses (e.g. `169.254.169.254`) are always refused with `UNSAFE_ADDRESS`.
- **Redirects** are not followed.

**Home Assistant quick controls** (`POST /api/integrations/:id/actions`, `apps:manage`) accept only
`toggle`/`turn_on`/`turn_off`, and only on entities in `controlEntities`, which are limited to the
`switch`, `light`, `input_boolean`, `fan`, `cover` and `script` domains. Every action is audited.

**PostgreSQL** statistics run one fixed query with `docker exec … psql -AtqX` inside a
`BEGIN READ ONLY` transaction. Container, role and database names are validated identifiers, and
the target image must be a PostgreSQL image.

## 5. App Store

Adapters are detected from the **image repositories actually deployed**, never from catalog
claims (`detectAdapters`). For example, `ghcr.io/home-assistant/home-assistant` maps to
`homeassistant`, while Kasm's internal `kasmweb/postgres` is deliberately not matched.

After a successful install, the Store offers the app's widgets: the generic container widget
targeting `app:<id>`, plus adapter widgets. The offer can open the connection form pre-filled with
the app, its name and a loopback address on its published port. Installed app cards have a
"Widgets" button for the same offer later.

## 6. Verification

Unit and API tests cover the following:

- **SDK:** manifests, sizes, layout, migration and desktop reassignment.
- **DataHub:** sharing, permissions, views, invalidation.
- **Collectors:** sockets, apt, timers, and the Postgres exec command.
- **Integrations:** secrets never returned, audience, SSRF refusal, offline, auth failure, HA
  entity minimization and controls.
- **Web:** topic ref-counting and layout geometry.

Browser tests (`tests/e2e/widgets.spec.ts`, `zz-store.spec.ts`) cover these flows:

- gallery placement on the desktop, sidebar and menu bar;
- configuration, drag, resize (including a refused overlap), persistence across reload, and
  restoring defaults;
- container target selection;
- a Jellyfin connection against a local fixture server: credential not returned, client IP not
  shown, auth failure, offline app, deleted connection;
- the post-install offer, and the removed-app state.

On the Raspberry Pi 5 (Ubuntu, systemd 259, Node 22), the dev-mode agent and API were run as an
unprivileged user from `/tmp`, with real backends and read-only access. The temporary directory was
removed afterwards.

- **Topics:** all 12 data topics returned `ok` with real data in two tabs at once. Timers were
  sorted, and APT reported list age without refreshing.
- **Sockets:** 52 listening sockets were reported, with process names for only 3 of them. Other
  users' `/proc/<pid>/fd` needs the root agent.
- **Resource use:** agent CPU averaged 4 % of one core with every topic subscribed, and fell to
  0 % within 15 s after the last subscriber left. RSS was about 107 MB for the agent and 93 MB
  for the API.
- **Address refusal:** a `169.254.169.254` integration was refused with `UNSAFE_ADDRESS`.

## 7. Limitations

- **Adapters against real apps:** the app adapters were verified against API fixtures and the
  documented APIs, not against the owner's apps. Home Assistant needs a token, and the Pi's
  PostgreSQL belongs to Kasm and must not be touched.
- **Unprivileged hosts:** socket process names and Raspberry Pi throttling flags need the
  production (root) agent.
- **Executable widgets:** there are no third-party executable widgets. A future model would run
  in a sandboxed iframe with a permission-checked message bridge.
- **Mobile:** the phone launcher does not show widgets yet.
- **Alerts** are current problems only. Alert history and notifications belong to the Phase 7
  notification center.
