# Community submissions

The community service lives in `services/community-registry`. It accepts independent publisher
submissions without repository access or pull requests. Its intended production origin is
`https://everyos.goktugceyhan.dev`. Local implementation and workerd/D1/R2 tests exist; the owner
still deploys it and supplies the real public trust anchor before EveryOS enables this source.
No production Cloudflare resources or signing keys are created by the development gate.

## Register and submit

The operator verifies your email and your right to the reverse-DNS publisher namespace outside
the service, then creates a one-day invitation. This is curated enrollment, not an automated email
verification service. Keep the invitation private. The CLI proves possession of your Ed25519 key;
knowing an email address or choosing a namespace alone grants no access.

The commands below run through the workspace CLI or the locally built, independently installed
archives described in [SDK distribution](distribution.md). Public release URLs become available
only with the complete EveryOS release. During development, invoke
`node <checkout>/packages/app-cli/src/cli.ts <command>` from your app folder, use an installed
workspace CLI binary, or install the tested standalone archives.

From your generated app project:

```bash
everyos-app keygen --out keys/publisher
# Read the operator's invitation into EVERYOS_COMMUNITY_INVITATION without putting it in shell history.
everyos-app community enroll --publisher-id io.github.alice --key keys/publisher.key
everyos-app pack
everyos-app community submit io.github.alice.notes-1.0.0.eosapp --icon store/icon.png \
  --screenshot store/screenshot.png --changelog "Initial version"
everyos-app community status
```

Use `--registry-url http://127.0.0.1:8787` for a local service; all other origins require HTTPS.
The package is signed locally; your private key is never uploaded. The store icon and up to eight
screenshots must be PNG or WebP. An SVG icon inside the sandboxed package is allowed, but its
public store icon needs a raster export.

Enrollment seals the developer token with `SecretBox` and a context bound to the exact registry
origin. The ciphertext is saved to `.everyos/community-token.json`; its separate, derived-key
source is the companion `.key` file. Both files use mode `0600`, with permission checks on the
key. The directory is git-ignored. Keep the key private and retain both files together if moving
credentials; copying only the ciphertext cannot authenticate. `--token-file` selects a different file;
`EVERYOS_COMMUNITY_TOKEN` overrides it for automation. Tokens last 90 days. `community rotate-token`
saves a replacement and revokes previous tokens; replace an environment override too if you use
one. Lost keys or tokens require the operator to verify you again and issue a recovery invitation.
Recovery keeps up to four historical public keys so published signatures remain verifiable, and
revokes old access tokens. Invitations are single-use and key proofs bind the invitation,
namespace and public key together.

A successful upload or submission is private. `community status` reports `pending`, `approved`
or `rejected`, with the operator's review note. Correct a rejected submission and submit again.
Once a version is approved its bytes are immutable: use a new version for changes. EveryOS still
checks compatibility and asks its administrator to approve requested capabilities at install or
update time; registry approval grants no host permissions.

```bash
everyos-app community revoke io.github.alice.notes 1.0.0 --reason "Security issue"
everyos-app community report io.github.alice.notes 1.0.0 --reason "Describe the observed problem"
```

Revocation requires the publisher token and namespace ownership (or the operator's admin token).
`'*'` revokes all versions, including future versions of that app id; it is not an undoable toggle.
Revocations remain in the signed index and EveryOS disables affected installations on its next
successful catalog sync. Revoked package downloads are blocked immediately at the service.
Reports are anonymous, rate limited and private to the operator.

## Operator: local development and deployment

The committed `wrangler.jsonc` has local-only D1/R2 bindings and a deliberately invalid production
D1 id. Create an ignored `.dev.vars` with a random admin bearer token (32–256 ASCII letters, digits, `_` or `-`) and
a separate development Ed25519 registry private key. Use Wrangler's dotenv multiline syntax for
the PEM. Never use either official signing key. Then:

```bash
cd services/community-registry
pnpm exec wrangler d1 migrations apply everyos-community --local
pnpm dev
```

`pnpm --filter @everyos/community-registry test` runs Vitest 5 against an actual bundled Worker in
Miniflare/workerd with local D1 and R2. It also executes the real developer CLI through the local
HTTP listener. This avoids the Vitest 4-only Workers pool; it does not mock the storage bindings.
`pnpm --filter @everyos/community-registry build` is a Wrangler dry run and performs no deployment.
`pnpm --filter @everyos/community-registry types` regenerates the committed binding/runtime types.
Only esbuild may run install scripts; workerd's postinstall is explicitly denied. Its native
optional platform package supplies the tested runtime binary.

The following production actions belong to the owner:

1. Confirm that `goktugceyhan.dev` is an active zone in the intended Cloudflare account, then
   create a D1 database named `everyos-community` and a private R2 bucket in that account.
   Keep the database UUID. R2 public access stays disabled.

   From `services/community-registry`, the owner can use the pinned CLI:

   ```bash
   pnpm exec wrangler login
   pnpm exec wrangler whoami
   pnpm exec wrangler d1 create everyos-community --update-config=false
   pnpm exec wrangler r2 bucket create everyos-community --update-config=false
   ```

   Confirm the intended account from `whoami` before the resource-creation commands. The
   production configuration command below needs the actual UUID returned by D1 creation;
   these commands leave the committed local bindings unchanged.

2. Generate a dedicated production Ed25519 community registry key pair and keep its private key
   outside the checkout. Keep the public key/fingerprint for independent verification. This key
   must differ from both official keys and every publisher key.
3. Generate and review the ignored production configuration:

   ```bash
   pnpm configure --database-id <real-D1-UUID> --bucket <real-R2-bucket-name>
   pnpm exec wrangler deploy --config wrangler.production.jsonc --dry-run
   ```

   The command refuses a placeholder UUID and refuses to overwrite an existing configuration.
   It fixes the custom domain to `everyos.goktugceyhan.dev` and sets the environment to production.

4. Prepare a private JSON or dotenv file **outside the checkout** containing the actual
   `ADMIN_TOKEN` and `REGISTRY_PRIVATE_KEY`; restrict its permissions to `0600` and retain the
   admin token in the owner's password manager. Do not send either value to the development
   agent. The first deployment uploads both required secrets together with the code using
   `--secrets-file`; it does not depend on secrets inherited from an earlier Worker version.
5. Apply the migration and perform the first deployment from `services/community-registry`:

   ```bash
   pnpm exec wrangler d1 migrations apply everyos-community --remote --config wrangler.production.jsonc
   pnpm exec wrangler deploy --config wrangler.production.jsonc --secrets-file /path/to/protected-community-secrets.json
   ```

   Review the selected account and generated configuration before running either remote command.
   The configured `custom_domain: true` creates the subdomain's DNS record and certificate on the
   active zone; no manually created A/CNAME record is needed for a new hostname. An existing
   conflicting CNAME needs owner review rather than automatic deletion. Verify the deployed cron
   trigger. Later `wrangler secret put` operations create and immediately deploy a new version;
   use the versioned secrets workflow when staging a change instead.

6. Call authenticated `POST /admin/publish` with `{}` to publish the initial signed catalog.
   Verify the public deployment with the independently retained public key using the command
   below. It checks production health, the discovery identity, `/registry.pub` and the fresh
   signed `/index.json` together.
7. Add the verified URL, key and fingerprint to `COMMUNITY_APP_REGISTRY` in
   `apps/api/src/modules/desktop-apps/anchors.ts`. Its current `null` value is intentional until these real
   production values and a deployed submission/install/update/revocation round trip are verified.

The release preflight also requires the matching live acceptance receipt and a fresh signed
index; see [SDK distribution](distribution.md#public-release-readiness). Choosing the domain does
not provision it. Until the owner creates the resources, deploys the Worker and verifies the
round trip, the complete EveryOS release stays blocked.

The agent never needs a Cloudflare account token. No tag, main-branch merge or public EveryOS
release is part of this deployment handoff.

The first-deployment and DNS behavior above is verified against the pinned Wrangler help and
Cloudflare's [secret upload](https://developers.cloudflare.com/workers/configuration/secrets/)
and [Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
documentation. The dry run is local; successful production deployment is still an owner action.

## Verify the deployed public service

From the repository root, after the owner has deployed and published the initial catalog:

```bash
pnpm community:inspect --public-key /path/to/independently-retained-community-public.pem
```

Only the public PEM is required. Do not download `/registry.pub` and use that same download as
the trust input: compare against the public key retained independently when the owner generated
the production pair. The command rejects private-key input before making requests. It sends four
bounded GET requests to the fixed HTTPS production origin with public DNS pinned and redirects
disabled; it sends no bearer token, cookie or request body and never calls an admin endpoint.
Local/staging health, a changed identity/key/index URL, an expired or invalid signature and an
unrelated registry all fail. Errors identify a fixed failed check without printing remote bodies.

To retain the sanitized result in ignored local state, select a new report path:

```bash
mkdir -p .dev
pnpm community:inspect --public-key /path/to/independently-retained-community-public.pem --out .dev/community-deployment.json
```

An existing report is never overwritten. This report uses
`everyos-community-deployment-verification/1` and explicitly leaves `lifecycleAcceptance` required.
It **cannot** satisfy `packaging/community-live-acceptance.json`: enrollment, submission, actual
human review, installation, update and revocation must still be exercised and evidenced separately.
Release preflight performs these same public deployment checks only after the real trust anchor
and complete current live acceptance receipt pass validation. Until then publication remains blocked.

## Operator API and human review

All administration uses `Authorization: Bearer <ADMIN_TOKEN>`. Developer endpoints require the
publisher-scoped bearer token unless explicitly listed as public. Requests with JSON bodies need
`Content-Type: application/json`; unknown JSON fields and query parameters are rejected.
There is no cookie authentication, browser administration interface or permissive CORS.

| Endpoint                                                                       | Authorization and body                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /admin/invitations`                                                      | Admin; `{publisherId,name,email,emailVerified:true,reason,recovery?:boolean}`. Set `emailVerified` only after actual verification. Returns the one-time invitation; transmit it privately. |
| `POST /v1/enroll`                                                              | Invitation + Ed25519 proof; the developer CLI creates the request. Returns the developer token once.                                                                                       |
| `GET /v1/me`                                                                   | Developer; namespace and public-key fingerprints, no email or credentials.                                                                                                                 |
| `POST /v1/token`                                                               | Developer; `{}` rotates all previous tokens.                                                                                                                                               |
| `POST /v1/artifacts/package?appId=...&version=...&signature=...`               | Developer; raw `.eosapp` bytes, publisher signature over the actual digest.                                                                                                                |
| `POST /v1/artifacts/image`                                                     | Developer; raw PNG/WebP bytes.                                                                                                                                                             |
| `POST /v1/submissions`                                                         | Developer; `{package:sha256,icon:sha256,screenshots?:sha256[],changelog?:string}`; every artifact must be owned by this publisher and present in R2.                                       |
| `GET /v1/submissions`                                                          | Developer; their latest 100 submissions and review notes.                                                                                                                                  |
| `GET /admin/submissions`                                                       | Admin; oldest 100 pending submissions and inspected manifest JSON.                                                                                                                         |
| `GET /admin/submissions/:id/:kind/:hash`                                       | Admin; download this submission's package or image as an attachment (`kind` is `package` or `image`).                                                                                      |
| `POST /admin/submissions/:id/review`                                           | Admin; `{decision:"approved" or "rejected",note}`. A conditional D1 transaction permits one decision only.                                                                                 |
| `POST /v1/revocations`                                                         | Developer; `{appId,version,reason}` within their namespace.                                                                                                                                |
| `POST /admin/revocations`                                                      | Admin; the same body.                                                                                                                                                                      |
| `POST /admin/publish`                                                          | Admin; `{}` refreshes or retries publication.                                                                                                                                              |
| `POST /v1/reports`                                                             | Public; `{appId,version?:string,reason}`.                                                                                                                                                  |
| `GET /admin/reports`                                                           | Admin; oldest 100 unresolved reports.                                                                                                                                                      |
| `POST /admin/reports/:id/resolve`                                              | Admin; `{resolution}`; resolution does not itself revoke a version.                                                                                                                        |
| `GET /health`, `/.well-known/everyos-registry`, `/registry.pub`, `/index.json` | Public; actual service state, identity or signed catalog. An unpublished/expired catalog returns 503.                                                                                      |
| `GET /packages/:hash`, `/images/:hash`                                         | Public only for approved, non-revoked references. Pending artifacts are never public.                                                                                                      |

Review the actual inspected manifest and download the submitted bytes and store images. Check
license/source provenance, declared capabilities and widget grants, static code behavior, CSP
compatibility, translations and screenshots before approving. Automated checks are archive,
manifest, signature, file-type, HTML-policy and locale checks; they do not certify arbitrary JS
behavior. The service never executes or dynamically imports a submitted package and never renders
its HTML. A rejection note is visible to its publisher. Security-relevant state changes have D1
audit events containing actor, action and subject ids, without tokens, emails, package contents
or private keys.

Approval/revocation commits before index publication. A `202 {publication:"pending"}` response
means the state change was recorded but the public index could not be refreshed; repair storage
or configuration and retry `/admin/publish`. The previous valid index remains available. A daily
03:17 UTC cron retries publication, refreshes indexes that expire within seven days, and removes
expired invitations, tokens and rate-limit records. Index lifetime is 30 days. D1 retains the
monotonic revision and points to an immutable R2 snapshot; an older concurrent signer cannot move
the pointer backwards. Package and store-image objects are content addressed and never replaced.
Uploaded artifacts are retained under the publisher quota; automatic artifact deletion is not
implemented, so a new submission cannot race a garbage collector deleting its bytes.

## Bounded initial service

| Limit                                                     | Value                                       |
| --------------------------------------------------------- | ------------------------------------------- |
| Package compressed / expanded bytes                       | 8 MiB / 32 MiB                              |
| Manifest / files                                          | 16 KiB / 2,000                              |
| HTML / locale file                                        | 256 KiB / 512 KiB                           |
| Store icon / screenshot                                   | 512 KiB / 2 MiB                             |
| Screenshots / pending submissions per publisher           | 8 / 20                                      |
| Retained artifacts per publisher                          | 300, with exact-byte upload retries allowed |
| Publishers / total approved versions / versions per app   | 500 / 200 / 50                              |
| JSON request body                                         | 16 KiB                                      |
| Package / image uploads per publisher per hour            | 20 / 60                                     |
| Mutating requests per peer per hour                       | 180                                         |
| Anonymous reports per peer per UTC day / unresolved total | 5 / 10,000                                  |

The community limits are deliberately smaller than private-registry/package-format limits to
bound Worker memory and the signed index. Increasing catalog capacity requires rechecking the
8 MiB index limit and runtime/resource acceptance. IP rate keys are HMACs; raw IPs are not retained.
D1 stores publisher contact addresses for operator verification; these are excluded from public
indexes and audit details. Access tokens and invitation secrets are stored only as SHA-256 hashes.
Registry/admin secrets use Cloudflare secret bindings. Back up D1 and private R2 together, retain
the registry key separately, and preserve `registry_state` and immutable index snapshots to avoid
sequence rollback after restoration.
