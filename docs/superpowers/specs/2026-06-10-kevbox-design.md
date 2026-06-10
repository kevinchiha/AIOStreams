# Kevbox Design — key-in-URL family config for the AIOStreams fork

**Date:** 2026-06-10 (revised same day after multi-agent gap audit — see Revision history)
**Branch:** `kevbox` (fork of [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams), upstream remote configured)
**Status:** Approved by Kevin (design discussion 2026-06-10; audit-driven revisions approved 2026-06-10)

## Problem

Stock AIOStreams v2 stores every configuration in the database behind a
UUID + encrypted password URL (`/stremio/{uuid}/{encryptedPassword}/...`).
Installing the addon for several family members means creating and
maintaining one DB config per person, and the debrid API key is never
visible or swappable.

Kevin wants: **one shared config** (his exported config), installed for each
family member by pasting a single URL where only the member's name and
Premiumize API key differ. Plus Torrentio enabled as the top addon, Kevbox
branding, no operator login, automatic upstream updates, and deployment on
his VPS under `streams.kevbox.dev`.

## Decisions made during design

| Question | Decision |
| --- | --- |
| Debrid services | Premiumize only; each family member has their **own** PM account/key |
| Template storage | **JSON file in the repo** (`kevbox.config.json`), not a DB config |
| Secrets in template | **`${ENV_VAR}` placeholders** substituted at load time (fork repo is public — no secrets in git) |
| Member identity | **Name segment in the URL** (`/k/mum/...`) for logs, stable identity, and per-member addon naming |
| Architecture | **Stateless synthetic config** (Approach 1) — no DB writes, template + URL params produce `UserData` per request |
| Domain | `streams.kevbox.dev` (DNS pointed by Kevin; `.dev` is HSTS-preloaded, HTTPS mandatory) |
| Member allowlist *(audit)* | **`KEVBOX_MEMBERS` env allowlist** — unknown names get a Stremio-friendly error. Closes the open-relay hole (strangers using Kevin's MediaFlow bandwidth / RPDB quota with their own PM key) and the same-name cache-sharing issue |
| Operator auth *(audit)* | **`AIOSTREAMS_AUTH_REQUIRED=true` + `CONFIG_ACCESS_KEY` env** — gates the configure page *and* anonymous DB-config creation (`POST /api/v1/user` is otherwise open). Kevbox injects the access key per request via `getConfigAccessKey()`, so family URLs work regardless. `ENABLE_SEARCH_API=false` |
| Boot validation *(audit)* | **Fail-loud**: when `KEVBOX_MEMBERS` is set, a broken template throws `ConfigStartupError` at boot; the auto-update health gate *also* probes a kevbox manifest URL |
| Degraded-UX fixes *(audit)* | Extend the rate-limit error regex in `middlewares/errors.ts` so kevbox URLs get the playable "Rate Limit Exceeded" stream; serve `/configure` on the kevbox router as a redirect to the instance configure page (behind the operator login while auth is on — fine for family use) |

Approaches rejected: auto-provisioning real DB users per member (unauthenticated
DB writes, template-drift re-sync complexity); upstream `ALIASED_CONFIGURATIONS`
aliases (still one DB config per member, no key in URL).

## 1. URL scheme & member identity

```
https://streams.kevbox.dev/stremio/k/{name}/{premiumizeApiKey}/manifest.json
```

- `name`: `[a-z0-9-]{1,20}` (e.g. `mum`, `kevin`) **and present in the
  `KEVBOX_MEMBERS` allowlist** (comma-separated names in the VPS `.env`).
  Used for: log lines, deterministic synthetic UUID (UUIDv5 of the name —
  stable across key rotations), and per-member manifest name **"Kevbox (Mum)"**
  via the existing `config.addonName` override (`routes/stremio/manifest.ts:38`).
  Unknown names are rejected with the same Stremio-friendly error stream as
  malformed ones. Adding a member = add the name to `.env`, restart.
- `apiKey`: the member's Premiumize API key. Swapping a key = editing the URL,
  nothing else.
- Onboarding a member = add name to `KEVBOX_MEMBERS`, paste URL into Stremio.
  No config creation, no DB row.
- Because the synthetic UUID is derived from the name only, uuid-keyed caches
  (e.g. the precache cooldown, `main/resources.ts:513`) are shared per name.
  The allowlist is what makes that safe — only the real member can use a name.

## 2. Fork code

### New file: `packages/server/src/routes/stremio/kevbox.ts`

Self-contained Express router, mounted at `/stremio/k/:name/:apiKey`
**before** the stock `/stremio/:uuid/:encryptedPassword` mount (so `k` is
never parsed as a UUID). Mirrors `stremioAuthRouter` — same `corsMiddleware`
and the same individually-exported resource handlers (`manifest`, `stream`,
`meta`, `catalog`, `subtitle`, `addonCatalog`) — but substitutes
`kevboxUserDataMiddleware` for `userDataMiddleware`, and adds a
`/configure` route that redirects to the instance configure page. With
`AIOSTREAMS_AUTH_REQUIRED=true` (§4) that page sits behind the operator
login — intended: family members have no business there, and it beats the
400 they would otherwise get (the shared manifest handler hardcodes
`behaviorHints.configurable: true`, so without this route every Stremio
Configure tap falls through to the `:uuid` router).

`kevboxUserDataMiddleware` per request:

1. Validate `name` and `apiKey` shape **and membership in `KEVBOX_MEMBERS`**;
   reject early with the same Stremio-friendly dynamic error streams the
   stock middleware uses (`StremioTransformer.createDynamicError`).
2. Load the template (module-level cache, invalidated on file mtime change).
   **A template load failure (missing file, unset env var, bad JSON) also
   responds with a friendly error stream** ("Kevbox is misconfigured — tell
   Kevin"), never an opaque 500.
3. Substitute `${ENV_VAR}` placeholders in string values from `process.env`.
4. Deep-clone, then inject: premiumize credentials `{ apiKey }` +
   `enabled: true`; `addonName = "Kevbox (Name)"`; synthetic UUID from name;
   kevbox-shaped self-manifest URL
   (`{baseUrl}/stremio/k/{name}/{apiKey}/manifest.json`); **the active config
   access key from `getConfigAccessKey()`** (so the operator-auth gate, which
   `validateConfig` enforces on every serve via `assertConfigAccessKey`,
   passes for family URLs — and key rotation is picked up automatically).
5. Run the same `validateConfig(userData, { skipErrorsFromAddonsOrProxies:
   true, decryptValues: true })` as the stock middleware.
6. Attach `req.userData`, `next()`.

`syncUserDataUrls` is skipped (no DB user to sync).

### Touched upstream files (the entire merge surface)

| File | Change |
| --- | --- |
| `packages/server/src/app.ts` | +3 lines: import kevbox router, mount it before the `:uuid/:encryptedPassword` route |
| `packages/server/src/server.ts` | +2 imports, +1 small block in `start()`: fail-loud kevbox template boot check |
| `packages/server/src/middlewares/errors.ts` | 1 regex extended: rate-limited kevbox requests get the playable "Rate Limit Exceeded" stream instead of raw 429 JSON |
| `packages/core/src/db/schemas.ts` | +1 optional field on the user-data schema: `selfManifestUrl` (string, optional) |
| `packages/core/src/main/index.ts` (line ~45) | Use `userData.selfManifestUrl` when present, else current interpolation |

That is **5 upstream source files, ~15 touched lines** (plus a 3-line
`.gitignore` append), plus new fork-local files (router, two utils, tests,
template, compose file, scripts).

Why the override is needed: `ctx.manifestUrl` is consumed by catalog
deep-links (`main/catalog.ts:46`); it is the only downstream consumer of
`encryptedPassword` (verified by grep across `packages/core`). `uuid` has
~a dozen other consumers (log lines, cache keys, analytics) — all of them
tolerate a synthetic-but-valid UUID; none does a DB lookup on the serve
path. The `uuid` schema field is `z.string().uuid()`, hence a real
(synthetic) UUID rather than a sentinel string.

Builtins note *(audit correction — the original spec wrongly claimed "no
builtin presets")*: the template **does** include two in-process builtin
presets (knaben, torrent-galaxy) plus `enableSeadex`. They are unaffected by
the kevbox auth shape for a different reason: builtin manifest URLs are
served from `appConfig.bootstrap.internalUrl` (`presets/knaben.ts:78`) and
embed service credentials; playback URLs embed an *encrypted store auth*
and are built from `appConfig.bootstrap.baseUrl`
(`/api/v1/debrid/playback/...`, `debrid/utils.ts:869`) — never
`uuid`/`encryptedPassword`. Operational consequences: builtin debrid
playback **transits the VPS** (bandwidth); playback URLs depend on a stable
`SECRET_KEY`; builtin manifests depend on `internalUrl` resolving inside
the container.

Explicitly out of scope / unaffected: `/chilllink/*` (separate client
protocol, unused by the family); per-user server state (library builtin,
cloud sync) — the template uses neither; `excludeUncached: true` means no
uncached-flow round-trips through user-authenticated paths.

## 3. Template: `kevbox.config.json` (repo root)

Kevin's exported config (`aiostreams-config-2026-06-10.13-19-05.json`) with
these edits:

- **Torrentio prepended as preset #1**: `type: "torrentio"`, enabled,
  `services: ["premiumize"]`, `resources: ["stream"]`, `timeout: 10000`.
  Torrentio needs no code changes: default URL `https://torrentio.strem.fun`
  is live on self-hosted instances (the public instance hides it; ours
  doesn't).
- `premiumize` service: `enabled: true`, `credentials: {}` (middleware
  injects the key).
- Secrets the export stripped become placeholders, e.g. MediaFlow proxy
  `url`/`password` → `${KEVBOX_MEDIAFLOW_URL}` / `${KEVBOX_MEDIAFLOW_PASSWORD}`,
  RPDB key → `${KEVBOX_RPDB_KEY}`.
- **Stale export artifacts removed** *(audit)*: the top-level
  `"trusted": false` (server-assigned from `TRUSTED_UUIDS`; upstream's own
  import flow deletes it) and the orphaned
  `"7be6b98.fankai_catalog"` catalogModifications entry (its FKStream preset
  is not in the export's presets list).
- **The export is lossy** *(audit)*: the SPA's `filterCredentials`
  (`save-install.tsx:1351-1393`) strips ~10 optional secret fields (tmdb
  keys, tvdb, topPoster, aioratings, proxy `publicUrl`, every service
  credential, password-type preset options). Absent-because-stripped is
  indistinguishable from never-set, and `validateConfig` cannot detect a
  missing *optional* key — so implementation includes a **one-time
  enumeration** of the live SPA config against that list to decide the
  complete placeholder set. The three placeholders above are the starting
  point, not a verified-complete contract.
- Template is loaded and validated **at server boot — fail-loud**: when
  `KEVBOX_MEMBERS` is set (i.e. kevbox is intended on this instance), a
  broken or missing template throws `ConfigStartupError` and the deploy
  fails; the auto-update script then rolls back. When `KEVBOX_MEMBERS` is
  unset (stock instance), boot logs a warning and kevbox routes reject all
  requests with a friendly error.

Editing workflow: edit JSON → commit on `kevbox` → push to origin; the
auto-update script fast-forwards the VPS from origin and redeploys (§5).
Because the template is **bind-mounted** into the container (§6), the
mtime-cache reload also applies edits made directly on the VPS file without
a rebuild. Propagation caveat *(audit)*: changes to **request-path
resources** (streams, filters, sorting, posters) apply on each member's
next request; changes that live in **manifest.json** (catalog list, addon
name, resources) are cached by Stremio clients at install time and only
refresh when the client re-pulls the manifest — they may effectively need a
reinstall. The manifest `version` field does not change on template edits.

## 4. Branding & operator auth (env only, no code)

```
ADDON_NAME=Kevbox
ADDON_ID=com.kevbox.stremio        # set once, BEFORE first family install
AIOSTREAMS_AUTH_REQUIRED=true      # gate configure page AND anonymous config creation
CONFIG_ACCESS_KEY=<openssl rand -hex 24>
ENABLE_SEARCH_API=false
```

*(Audit correction — the original spec said `AIOSTREAMS_AUTH_REQUIRED=false`
and claimed re-enabling it later "does not affect the family". Both were
wrong: with auth off, **anyone** can create persistent DB configs via
`POST /api/v1/user` and use the search API on a public instance; and
`validateConfig` runs `assertConfigAccessKey` on **every serve**
(`utils/config.ts:128`, `utils/auth.ts:166-181`), so enabling auth without
the kevbox accessKey injection would break every family install. With the
injection in §2 step 4, auth stays on and family URLs are unaffected —
including across key rotations.)*

## 5. Auto-update: `scripts/kevbox-update.sh` + timer

Runs on the VPS on a systemd timer **as the deploy user (not root** — git
2.35.2+ refuses to operate on another user's repo with "dubious ownership",
which would kill every run under `set -e`). Logic per run:

1. Take an exclusive lock (skip if another run is in flight).
2. `git fetch origin + upstream --tags`. **Origin is the source of truth**:
   fast-forward `kevbox` to `origin/kevbox` (this is what deploys template
   edits and manually-resolved merges). Local-ahead is fine (prior push
   failed — will re-push); real divergence is a loud error.
3. Find the newest upstream release tag (`v*`, pre-release suffixes
   excluded defensively). Skip tags recorded in the **failed-tags state
   file** (so a broken tag is not re-merged/re-deployed every day; clearing
   the file retries). If the tag isn't an ancestor → `git merge`;
   **on conflict: `git merge --abort`, alert, exit non-zero** — never deploy
   a half-merge; conflicts wait for Kevin.
4. If `HEAD` equals the **deployed-SHA state file** → exit 0 (idempotent).
5. Build. A build failure leaves the running deployment untouched: reset to
   the deployed SHA, record the failed tag, alert, exit non-zero.
6. Stop the container, **snapshot the data dir** (via a throwaway alpine
   container, so bind-mount file ownership doesn't matter — and a stopped
   SQLite is the only consistent snapshot), then up. Upstream migrations are
   **up-only** and run at boot (`db.ts:27`, `assertSchemaUpToDate` exits the
   process on schema-ahead) — so rollback *must* restore the DB snapshot or
   the rolled-back container crash-loops.
7. Health gate: `/api/v1/health` **and** a kevbox manifest probe
   (`/stremio/k/{first allowlisted member}/{dummy key}/manifest.json` must
   return `"Kevbox ("`). The DB-only health endpoint alone cannot see a
   kevbox-broken deploy.
8. On success: write the deployed SHA, `git push origin kevbox` (**push
   failure is a loud error**, not a warning — silent divergence breaks every
   later run), prune dangling images.
9. On failure: restore the data snapshot, reset to the deployed SHA,
   rebuild, re-deploy, **re-run the health gate on the rollback**, record
   the failed tag, alert. A rollback that is *also* unhealthy alerts
   CRITICAL.

Alerts: every conflict/rollback/push-failure posts to `KEVBOX_NTFY_URL`
(any ntfy/webhook endpoint) when set, in addition to the log file — Kevin
should not have to remember to read a VPS log to learn the pipeline is stuck.
The script reads the URL from the repo `.env` (the systemd unit does not
source `.env`, so an env-only contract would silently disable alerting).
State (deployed SHA, failed tags, data snapshot) lives under
`/opt/kevbox/state/`. The systemd unit sets `TimeoutStartSec=3600` (oneshot
units otherwise default to *infinity* — one hung in-container `pnpm build`
would silently suspend all future timer runs) and log output is rotated via
logrotate.

Known residual risk *(audit)*: the largest piece of fork code, `kevbox.ts`,
**duplicates** upstream router internals rather than sharing them — and a
file only we touch can never produce a merge conflict. The abort-on-conflict
gate therefore does not protect against upstream changing middleware
composition or `validateConfig` semantics out from under the copy ("silent
drift"). Mitigations: the app-level integration test (§7) and the
post-deploy kevbox manifest probe (step 7), which turn silent drift into a
failed gate + rollback.

## 6. Deployment on `persovps`

- Docker Compose building from the git checkout of `kevbox` (VPS already runs
  Docker). SQLite (default, `./data/db.sqlite`) on a volume — barely used
  since members are not DB rows, but required for boot.
- **The template must be bind-mounted** *(audit — the upstream Dockerfile's
  distroless final stage copies only built artifacts with `WORKDIR /app`;
  `kevbox.config.json` would otherwise not exist in the image at all and
  every kevbox URL would fail in production while the local `pnpm start`
  smoke test passes*): `./kevbox.config.json:/app/kevbox.config.json:ro`.
- **Pinned compose subnet + `TRUSTED_IPS`** *(audit)*: the default
  `TRUSTED_IPS` is docker0 (`172.17.0.0/16`) plus loopback, but compose
  creates its own subnet — without pinning one and adding it to `TRUSTED_IPS`,
  `X-Forwarded-For` is never honored and **every client on the internet
  shares one rate-limit bucket**. Compose pins `172.30.0.0/16`; `.env` sets
  `TRUSTED_IPS=172.30.0.0/16,127.0.0.1/32,::1/128`.
- Container log growth capped via compose `logging` options.
- `.env` on the VPS: `SECRET_KEY` (64-char hex), `BASE_URL=https://streams.kevbox.dev`,
  the `KEVBOX_*` placeholder secrets, `KEVBOX_MEMBERS`, branding + auth vars
  (§4), `TRUSTED_IPS`, optional `KEVBOX_NTFY_URL`.
- Reverse proxy: reuse whatever already fronts the VPS (nginx/caddy/traefik —
  inspected during implementation) and add a `streams.kevbox.dev` vhost with
  TLS. `.dev` requires HTTPS (HSTS preload). **Access logging must be off
  (or URI-stripped) for this vhost** *(audit)*: default nginx/traefik access
  logs persist the full request line — i.e. every member's Premiumize key —
  in plaintext on disk, which is beyond the accepted *in-transit* trade-off.

## 7. Testing

- **Unit** (vitest, server package): template loader (placeholder
  substitution, missing-env failure, mtime cache invalidation); UserData
  builder (key injection, stable synthetic UUID per name, addonName format,
  name/key shape rejection, accessKey injection).
- **Integration** *(restored by audit — it had been silently dropped from the
  plan)*: boot the built server against a fixture template;
  `GET /stremio/k/mum/{key}/manifest.json` → 200 with `name: "Kevbox (Mum)"`;
  malformed key and non-allowlisted member on a stream URL → playable
  dynamic error (200), non-allowlisted member on `manifest.json` → 4xx
  APIError; `/configure` → redirect. (A malformed *name* can only ever hit
  the allowlist rejection — it is not a distinct path.)
- **Deploy gate**: the auto-update health gate probes a real kevbox manifest
  URL post-deploy (§5 step 7), so route-level breakage rolls back instead of
  shipping.
- **Manual**: real install on one device against the VPS before family
  rollout.

## Risks & accepted trade-offs

- **PM key in URL plaintext**: fine over HTTPS in transit; Stremio syncs
  installed addon URLs to its account cloud — true of every config-in-URL
  Stremio addon (stock Torrentio included). Accepted for family use.
  At-rest exposure in reverse-proxy access logs is **not** accepted — those
  are disabled for the vhost (§6).
- **Per-member server state unavailable** (library, sync): unused by the
  template today; if wanted later, those members need real DB configs.
- **Merge surface**: ~15 touched lines across 5 upstream files + new
  fork-local files. Conflicts possible only if upstream rewrites those exact
  spots; auto-update aborts safely when that happens. The bigger long-term
  risk is **silent drift** in the duplicated router code (§5) — mitigated by
  the integration test and the post-deploy kevbox probe, not by merge
  conflicts.
- **Builtin playback transits the VPS** (knaben/torrent-galaxy debrid
  playback URLs): VPS bandwidth cost, dependence on stable `SECRET_KEY`.
  Accepted — same behavior as the stock instance.
- **Manifest-level template changes don't propagate instantly** (§3
  propagation caveat). Accepted; rename/catalog changes are rare.

## Out of scope

- Multiple debrid services in the kevbox URL (PM only; revisit if a member
  switches services).
- Any frontend/SPA changes (configure UI untouched).
- Migrating existing watch history (separate concern; see the
  stremio-trakt-migration skill if needed).

## Revision history

- **2026-06-10 v2** — incorporated all 28 confirmed findings from the
  multi-agent gap audit (46 agents, every finding adversarially verified
  against the codebase; 0 refuted). Major changes: template bind mount
  (feature was dead in the planned Docker deploy), fail-loud boot validation
  + kevbox-aware health gate (spec/plan contradiction), `KEVBOX_MEMBERS`
  allowlist (open relay), auth flipped to required + per-request accessKey
  injection (anonymous DB-config creation; false "re-enabling login is
  safe" claim), origin-first auto-update with state file, DB snapshot/restore
  around deploys, non-root systemd user, `TRUSTED_IPS`/subnet pinning,
  access-log redaction, corrected builtins/merge-surface/propagation claims,
  restored integration test, alerting.
- **2026-06-10 v1** — initial approved design.
