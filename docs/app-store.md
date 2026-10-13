# App Store — Phase 5

Phase 5 is implemented and verified with real Docker in a disposable ARM64 Linux VM. The runtime
contract is standalone Linux Docker Compose. Parsing a catalog does not mean every upstream
application was deployed; features outside this contract produce explicit blockers/skipped entries.

## Applications folder

Store-managed installations automatically appear in **Applications** on the desktop and in
the launcher, the Files Favorites sidebar and the user's home view. Files opens the same live
collection inside its own window and remembers it across reloads; Back returns to the home.
The home entry is available in both icon and list views. An existing physical folder with the
same localized name remains independent and usable. The collection is excluded from file
rename, clipboard, trash and drop operations.
This live folder includes existing installations; removing an application removes
its entry on refresh. Its icon view supports Ctrl/Command/Shift selection, select-all and marquee
selection, with a shared highlight around each selected icon and name and adaptive captions.
Double-click launches a running application's real
published web endpoint. A stopped app, an app without a reachable web endpoint or a simulated app
opens its management details instead. Details use the store's existing permissioned lifecycle
controls; simulated deployments stay explicitly labeled and never produce fabricated launch links.

Right-click an installation in either Applications window to add it to the Dock or current
desktop, update its images, uninstall it or view information. Updating and uninstalling reuse
the Store confirmation, permission checks, jobs and audit history. Cancel leaves the installation
untouched. Progress and request errors remain dismissible.

Dock and desktop shortcuts persist per user by installation ID, keeping localized names and
proxied catalog icons. Opening a shortcut fetches the current installation and published web
ports first. Stopped, simulated or non-web apps open their management details without being
started automatically. An authoritative application listing removes obsolete shortcuts after
uninstall; a failed or offline listing does not erase preferences. Duplicate desktop shortcuts
are prevented per virtual desktop, and the existing Dock/desktop limits remain enforced.

The folder groups launchers rather than moving container volumes, images or application data.
Upgrades add its desktop shortcut once while preserving custom layouts; removing that shortcut
does not uninstall applications or recreate it on the next sign-in. The launcher still opens the
folder. App icons use the existing bounded same-origin catalog asset endpoint, with a local glyph
when an image/catalog is unavailable.

Store job notices, per-app last-operation summaries and lifecycle errors have a dismiss button.
Closing a running notice keeps its job watcher mounted, so completion, refreshed real state and
widget offers still arrive. The next explicit action displays a new notice. Dismissal does not
cancel an installation/start/stop/update or alter the persisted job/audit history.

## Catalogs and metadata

Administrators manage source URLs, format hints and explicit private-network permission. Sync
commits a complete snapshot atomically; invalid/empty sources and failed downloads preserve the
previous snapshot. Invalid templates are reported by path/reason. Disabling or removing a catalog
never removes installations or their source provenance.

Readers support CasaOS/ZimaOS v2 store/index JSON, CasaOS source ZIPs (including Big Bear and the
compact legacy store), Runtipi native/dynamic v2 ZIPs, Coolify base64 JSON/template directories,
Portainer legacy/v2/v3 container and GitHub Compose-stack templates, and plain Compose URLs/ZIPs.
Windows and Swarm entries are explicitly unsupported on this Linux Compose runtime.

V2 repository `url` is metadata; the index is fetched beside the store. Prefix-relative assets
resolve against `base_url`. Matching architecture manifests take precedence. An unchanged native
content hash plus index/base identity reuses cached manifests; changes fetch fresh content.
Runtipi architecture overrides merge declared services. Form labels/hints/options/types, numeric
and length bounds, regex constraints and hex/base64 random fields are retained and checked on the
server. Untrusted patterns use RE2, avoiding JavaScript backtracking regex execution.

CasaOS `/DATA/AppData/…` becomes isolated `${APP_DATA_DIR}/…`; unrelated host paths retain their
host-access risk. Fixed container names are removed and default `bridge` becomes the project
network. Coolify supports password/user/encoding generators, paired URL/FQDN inputs, Supabase JWTs,
embedded `volumes.content` and explicitly declared relative directory volumes. A service URL's
explicit port suffix supplies an editable published port when none exists. Existing proxies are
never enrolled through catalog labels; URLs, DNS, TLS and reverse proxies remain owner-managed.
Declared Docker health checks stay enforced even when Coolify metadata excludes a service from
its own health checker.

Typical runtime sources:

```text
https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages/store.json
https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages/store/main.zip
https://codeload.github.com/bigbeartechworld/big-bear-casaos/zip/refs/heads/master
https://codeload.github.com/runtipi/runtipi-appstore/zip/refs/heads/master
https://cdn.coollabs.io/coolify/service-templates-latest.json
https://raw.githubusercontent.com/portainer/templates/v3/templates.json
```

HTTP(S) only; URL credentials and credential-like query parameters are rejected. Every connection
validates DNS and pins the selected address; redirects repeat the check. Nonpublic addresses need
explicit source permission; link-local metadata and IPv4-mapped IPv6 remain forbidden. Bounds:
90-second session, 15-second socket timeout, four redirects, 24 MiB root body, 512 KiB manifest and
32 MiB total transfer. ZIP parsing rejects traversal, symlinks, duplicates, encryption, invalid CRCs
and oversized metadata. Remote content is neither extracted nor executed.

Notes/descriptions render as text. Links permit HTTP(S) only. Icons/screenshots use authenticated,
SSRF-safe raster proxies, PNG/JPEG/WebP signatures and cache invalidation. No browser hotlinks or
remote HTML. Screenshots are limited to 12 per app and 2 MiB each. Logical duplicates use the main
image repository and normalized app name and remain selectable variants. Snapshot hashes cover
manifests/architecture variants; installations retain catalog, format, path and exact snapshot.

## Installation and ownership

Requests carry snapshot identity, declared variables, editable host ports and risk acknowledgement.
New installations automatically obtain PUID/PGID from the caller's linked Linux UID and primary
GID, and TZ from the agent's host timezone. The typed read-only `apps.defaults` operation requires
`apps:manage` and a real linked account in production. These fields are absent from the dialog;
matching literal environment defaults are replaced as well as declared interpolation variables.
No shell environment is imported. Existing installations retain their saved configuration.

Ports omitted from the request use Docker's native available-port allocation rather than a
check-then-bind probe. The agent reads the assigned ports from that exact owned project's real
containers, recreates its deployment with those fixed bindings, and saves them in its encrypted
deployment. Restart, retry and image update reuse those allocations. Missing binding proof or
a failed pinning deployment triggers cleanup of only the new owned project. Original loopback
and explicit host-IP restrictions and TCP/UDP protocols are preserved. See
[Docker port allocation](https://docs.docker.com/get-started/docker-concepts/running-containers/publishing-ports/#publishing-to-ephemeral-ports).

Optional variables and manual fixed ports live under **Advanced settings**. A blank host-port
field means automatic allocation; explicitly supplied fixed ports are respected and can fail if
occupied. Apps requiring external endpoints or nongenerated secrets still ask for those real
inputs. Host-network applications use their own network settings and cannot have their ports
remapped this way. After installation, launch the app to finish its own setup in its native panel.

Changed snapshots, unknown/missing inputs, incompatible architectures and unsupported Compose fail.
No host environment is inherited. Generated values are created on the server or explicitly
replaced through declared fields. Secret defaults are hidden and require input unless a generator
exists. Fixed public credential literals remain consistent across services and require warning
acknowledgement; they are not a production credential policy.

The dialog shows images, architectures, ports and mount source/target/access modes. Host paths,
privileged mode, namespaces, devices, capabilities, Docker sockets and unconfined settings require
administrator approval. The agent rechecks policy. Builds, hooks, external/custom-driver resources,
external env/config/secret files, undeclared relative files and unresolved interpolation cannot be
overridden.

Each UUID receives `otk-<UUID-without-dashes>`; existing projects/directories are rejected. Ownership
comes from SQLite and a private agent configuration hash rather than labels. A private install
intent permits interrupted directory/marker recovery. `${APP_DATA_DIR}` resolves under
`/var/lib/everyos/apps/<instance>/data`. Root/instance parents are private; new bind directories allow
container UIDs to write through mounts without chmod of existing data. Existing components are
checked for symlinks. Removal retains data and writes an ownership tombstone.

The API seals configuration with `app:<instance>:compose:v1`. The agent seals its pinned deployment
with a key derived from the persistent agent key and `app:<instance>:deployment:v1`. Compose receives
stdin, fixed arguments and the discovery socket; secrets never become arguments or plaintext disk
files. Embedded configs use read-only files under `/run/everyos/app-configs/<instance>/configN`, with
private root-owned parents on verified Linux tmpfs. Missing/non-tmpfs storage fails explicitly.
After host reboot, an App Store start/retry may be needed to rematerialize these runtime files.

Images resolve for the host architecture, verify against Docker metadata and pin by repository
digest or immutable local image ID. Wrong platforms/digests fail before deployment. Explicit local
`pull_policy: never` is respected; updates otherwise pull before changing services. Simulated
results show references with null digests and the simulation badge.

Managed `up` waits up to 120 seconds for running/healthy services. CLI output is discarded because
it may contain credentials. Failed initial installation/retry runs `down` only in its new namespace.
Failed update restores the previous pinned configuration with an independent 60-second deadline;
pull failure leaves the current deployment intact. No rollback/removal deletes data, images or
volumes or runs prune. Image rollback does not reverse application database/schema changes; the
update dialog states this. Application-aware backup/restore belongs to Phase 7.

Early development installations without an encrypted pinned agent deployment must complete an
explicit retry before updating. The agent refuses such updates before any image/container mutation
instead of claiming it can restore an artifact it never recorded.

## Durable jobs and data transfer

API jobs allow two concurrent operations and one per instance. Authenticated read-only SSE reports
queued/deploying/terminal states, with polling fallback and no invented percentages. Audits record
safe actor/instance/job/outcome fields, never secrets. The agent writes the API job ID in its terminal
journal. API restart marks incomplete jobs interrupted with unknown rollback. Reconciliation uses
only an idle agent's exact latest interrupted job result; older results are never guessed to belong
to a newer request. Retry rechecks ownership/policy. Generic Docker actions share the project lock,
including the source lock during copying. Job outcomes survive browser reload. Running/stopped/
missing/degraded state comes from Docker; launch links use published main-service TCP ports and the
configured path, respecting loopback bindings.

Installations can copy data from an explicitly confirmed, stopped, owned instance whose mounts all
use its app-data root. The source remains unchanged. Regular files/directories preserve ordinary
permissions and UID/GID on Linux; symlinks, hardlinks and special files fail. Bounds: 10,000 entries
and 1 GiB. Live or concurrently changing sources are rejected. External paths/named volumes are
outside this transfer contract; the owner must choose a compatible target application/version.

## Contracts and verification

Catalog mutations/listing require `catalogs:manage`. App/catalog-app/job/raster reads require
`apps:read`. Install, lifecycle and reconciliation require `apps:manage`, CSRF and an unlocked
session. Stop/restart/update/remove/retry require exact instance-ID confirmation; copying requires
exact source-ID confirmation. Bodies/parameters/queries use strict zod. Generic project import/
actions cannot take over an App Store installation. Agent `apps.run` is a user-only typed audited
mutation with a 12-minute deadline; `apps.inspect` is a user-only typed read with a 10-second deadline.

Live safe reads on 2026-10-10 parsed 178 CasaOS v2 apps (all with architecture variants), 359 Coolify
apps and 56 Linux Portainer apps. Policy admitted 151, 341 and 50 respectively; 14 Portainer entries
were skipped. Admission is not proof that every application was deployed. Upstream counts can change.

The [Linux acceptance record](phase5-acceptance.json) uses Node 26.11.1, Docker 29.9.0 and Compose
5.6.0, a root agent and a separate UID 1000 API. Thirteen real scenarios cover healthy HTTP access,
nonroot data permissions, encryption, tmpfs config, lifecycle, failed-install cleanup, image rollback,
source-preserving copying, ownership/policy refusal, API-crash recovery/retry, agent restart and
removal with data/foreign-resource preservation. Only original fixtures were deployed in a dedicated
VM; owner services were untouched. ARM64/AMD64 packaging and host-specific hardening remain Phase 8.

Unit/API tests cover transport/archive bounds, adapters/forms/JWTs, image identity/platform checks,
permissions, raster caching, snapshot preservation, encryption, ownership recovery, source locks and
rollback failures. Browser acceptance covers connected catalog/install/progress/lifecycle behavior
using the explicitly labeled development simulator.

To stage the standalone acceptance harness:

```bash
pnpm build
node scripts/build-app-acceptance.ts
```

Run `dist/accept-app-store.mjs` only in a new disposable Linux VM/runtime with Node 26, Docker
CLI/Compose, an empty daemon and shared agent/daemon bind paths. Set
`EVERYOS_DISPOSABLE_ACCEPTANCE=1`, `EVERYOS_ACCEPTANCE_DOCKER_ID` to that daemon's ID,
`EVERYOS_ACCEPTANCE_DIST` to the absolute build path and optionally
`EVERYOS_ACCEPTANCE_STATE_ROOT` to a private output directory. A different/nonempty daemon is refused.
The API runs as UID/GID 1000 and the result JSON contains no secrets. The shared
`/run/everyos/app-configs` mount must be tmpfs. Test data and the foreign-resource fixture remain for
inspection; discard or stop only that dedicated VM afterwards.

Migration 5 repairs early catalog-only v4 development databases without resetting data. Migration 6
adds deployment metadata and screenshot caching. Startup makes a pre-migration backup automatically.
