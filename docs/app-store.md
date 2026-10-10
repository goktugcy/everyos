# App Store — Phase 5 initial implementation

The App Store now reads real remote catalog data and installs applications through a typed agent
operation. Phase 5 remains in progress: the working catalog/installation/lifecycle flow does not
claim full compatibility with every upstream template.

Schema migration 5 adds missing managed-installation tables for early development databases that
had already applied the catalog-only form of migration 4. It also preserves installations in
databases that applied the complete form. Startup creates a pre-migration backup automatically;
existing catalogs, accounts and settings do not need to be reset.

## Catalogs

Administrators add a source URL, optional format hint, and an explicit per-source private-network
permission. Catalogs can be synchronized, disabled, enabled, or removed. Synchronization replaces
the snapshot atomically; a failed download or an empty/invalid source preserves the last successful
snapshot. Invalid individual templates are reported with their paths and reasons. Disabling or
removing a catalog never deletes an installation or its provenance.

Supported readers:

- CasaOS/ZimaOS v2 store/index JSON, with Compose and metadata resolved against `base_url`.
- CasaOS source ZIPs, including Big Bear and the compact legacy CasaOS store ZIP.
- Runtipi ZIPs: native `x-runtipi` YAML takes precedence, otherwise dynamic Compose v2 is converted.
  Obsolete static YAML is not substituted for the current dynamic manifest.
- Coolify's self-contained JSON with base64 Compose templates, and Compose template directories.
- Portainer v2/v3 container templates and GitHub-backed Compose stack templates. Swarm templates
  are reported as unsupported.
- A plain Compose URL or a ZIP containing Compose files.

Useful source URLs (fetched at runtime, never bundled into Otuken):

```text
https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages/store.json
https://cdn.jsdelivr.net/gh/IceWhaleTech/CasaOS-AppStore@gh-pages/store/main.zip
https://codeload.github.com/bigbeartechworld/big-bear-casaos/zip/refs/heads/master
https://codeload.github.com/runtipi/runtipi-appstore/zip/refs/heads/master
https://cdn.coollabs.io/coolify/service-templates-latest.json
https://raw.githubusercontent.com/portainer/templates/v3/templates.json
```

HTTP(S) only; credentials in URL authority and credential-like query parameters are rejected.
Every connection validates DNS results and pins the selected address. Redirects repeat this check.
Loopback/private/reserved addresses are rejected by default; link-local metadata and IPv4-mapped
IPv6 addresses remain forbidden even with private-network permission. Downloads have a 90-second
session deadline, a 15-second socket timeout, at most four redirects, a 24 MiB root-body limit,
512 KiB per manifest, and a 32 MiB total transfer budget. ZIP parsing rejects traversal, symlinks,
duplicates, encryption, invalid CRCs and oversized metadata. Nothing is extracted or executed.
Only raster icons are fetched, checked by signature, cached, and served by the authenticated API;
the browser never hotlinks upstream images or renders catalog HTML.

Logical duplicates use the main image repository and normalized application name. They remain
separate source variants with an indication in the browser. Snapshot hashes include fetched
manifests, and every installation preserves the exact source format, snapshot and path.

## Installation and ownership

Install requests carry a snapshot identity, declared variables, editable host ports and explicit
risk acknowledgement. Changed snapshots, unknown/missing variables, incompatible declared
architectures and unsupported Compose features are rejected. No host process environment is
inherited. Generated values are created on the server unless the user supplies a declared override;
the form allows known login credentials to be chosen without exposing generated values.
Secret-valued variable defaults are hidden
and require explicit input unless the source declares a supported generator. Fixed upstream
credential literals are preserved to avoid breaking relationships between services and produce a
`default-secret` warning that requires acknowledgement. They are public source data, not a safe
production credential policy.

Risks are derived from Compose, not catalog metadata. The installation dialog lists mount sources,
container targets and read/write modes before acknowledgement. Privileged mode, host namespaces, host
filesystem/device access, extra capabilities, Docker sockets and unconfined security settings
require an administrator override. Unpinned images and fixed credential defaults are warnings.
The agent independently checks these rules; unsupported host-side Compose features cannot be
overridden. Builds, lifecycle hooks, external/custom-driver resources, env/config/secret files,
relative binds and unresolved interpolation are rejected.

Each installation receives a UUID and an `otk-<UUID-without-dashes>` Compose project. The agent
refuses existing projects/directories instead of adopting them. Ownership comes from SQLite and
an agent-owned configuration hash, not container labels. `${APP_DATA_DIR}` resolves only inside
that instance's agent-owned data directory. Arbitrary source host paths remain explicit host-access
risks; they are not automatically imported, moved, rewritten or removed.

Rendered configuration is encrypted with `SecretBox` using `app:<instanceId>:compose:v1`. The
agent passes decrypted configuration to Compose through stdin, without plaintext secret files or
secret command-line arguments. It executes fixed CLI argument arrays against the discovery socket.
Managed `up` waits up to 120 seconds for services to be running/healthy. Only the job outcome is
returned; CLI output may contain credentials and is discarded.

Failed initial `up` triggers `down` for that new project only, with an independent 60-second
rollback deadline. Neither rollback nor removal uses volume/image deletion or prune. Application
data, images and volumes remain. Failed rollback is reported explicitly. A root-owned tombstone
prevents replaying a removed installation. Protected containers and the development-mode host
mutation prohibition also apply to managed apps.

Installation and lifecycle work runs as bounded API jobs (two concurrent operations, one per
instance). Read-only SSE exposes queued, executing and terminal states; it does not invent image
pull percentages. Polling provides a fallback. Audit records contain actor, instance, job and safe
outcome codes only. After API restart, incomplete jobs are marked interrupted with unknown rollback;
the installed list derives current running/stopped/missing state from real Docker discovery.

## HTTP and agent contracts

- `GET/POST /api/catalogs`, `PATCH/DELETE /api/catalogs/:id`, `POST /api/catalogs/:id/sync`:
  `catalogs:manage`.
- `GET /api/catalogs/apps`, `GET /api/catalogs/apps/:id/icon`, `GET /api/apps`,
  `GET /api/apps/jobs/:id`, `GET /api/apps/jobs/:id/events`: `apps:read`.
- `POST /api/apps/install`, `POST /api/apps/:id/actions`: `apps:manage`; stop/restart/update/remove
  additionally require the exact instance ID as confirmation.
- Agent `apps.run`: strict UUID/action/configuration contract, `apps:manage`, user actor only,
  mutation audit, 12-minute hard timeout and independent agent policy checks.

All route bodies, path parameters and query objects are validated; mutation routes retain CSRF
and session-lock enforcement. Docker discovery marks installed projects `managed`; generic project
import/action controls do not take over the App Store's configuration.

## Verification and remaining work

The development end-to-end test uses an original HTTP catalog fixture with explicit private-network
permission and the labeled Docker simulator. It covers source creation/sync, variable input,
installation, streamed progress, stop/start, source removal without affecting the installation,
and app removal. Unit/integration tests cover SSRF, archive limits, adapter selection, permissions,
snapshot preservation, secret encryption/redaction, policy revalidation and rollback failures.
Real read-only synchronization on 2026-10-10 parsed 178 CasaOS, 359 Coolify and 58 Portainer apps; unsupported
Portainer entries were recorded rather than silently approximated. No real host Docker resources
were changed during development.

Still required before closing Phase 5:

- Disposable Linux-host acceptance of successful/failed installs, data permissions, rollback,
  interrupted-agent recovery and root-agent deployment.
- Broader upstream compatibility: Runtipi architecture overrides and form constraints/encodings,
  Coolify ingress/embedded configuration and JWT generators, Portainer legacy/Swarm variants.
- Incremental v2 fetches, per-architecture digest selection/verification, screenshot caching,
  richer metadata/environment editing and application launch links.
- A durable reconciliation/retry UI for interrupted jobs and failed ownership preparation;
  health-aware update rollback and application-data migration remain unimplemented.

These limitations are intentionally visible as blockers, unresolved inputs, skipped entries or
documented unsupported metadata. Parsing a template is not a claim that its application was tested
on a production host.
