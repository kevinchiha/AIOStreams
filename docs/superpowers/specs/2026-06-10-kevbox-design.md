# Kevbox Design — key-in-URL family config for the AIOStreams fork

**Date:** 2026-06-10
**Branch:** `kevbox` (fork of [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams), upstream remote configured)
**Status:** Approved by Kevin (design discussion 2026-06-10)

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

Approaches rejected: auto-provisioning real DB users per member (unauthenticated
DB writes, template-drift re-sync complexity); upstream `ALIASED_CONFIGURATIONS`
aliases (still one DB config per member, no key in URL).

## 1. URL scheme & member identity

```
https://streams.kevbox.dev/stremio/k/{name}/{premiumizeApiKey}/manifest.json
```

- `name`: `[a-z0-9-]{1,20}` (e.g. `mum`, `kevin`). Used for: log lines,
  deterministic synthetic UUID (UUIDv5 of the name — stable across key
  rotations), and per-member manifest name **"Kevbox (Mum)"** via the
  existing `config.addonName` override (`routes/stremio/manifest.ts:38`).
- `apiKey`: the member's Premiumize API key. Swapping a key = editing the URL,
  nothing else.
- Onboarding a member = paste URL into Stremio. No config creation, no DB row.

## 2. Fork code

### New file: `packages/server/src/routes/stremio/kevbox.ts`

Self-contained Express router, mounted at `/stremio/k/:name/:apiKey`
**before** the stock `/stremio/:uuid/:encryptedPassword` mount (so `k` is
never parsed as a UUID). Mirrors `stremioAuthRouter` exactly — same
`corsMiddleware` and the same individually-exported resource handlers
(`manifest`, `stream`, `meta`, `catalog`, `subtitle`, `addonCatalog`) — but
substitutes `kevboxUserDataMiddleware` for `userDataMiddleware`.

`kevboxUserDataMiddleware` per request:

1. Validate `name` and `apiKey` shape; reject early with the same
   Stremio-friendly dynamic error streams the stock middleware uses
   (`StremioTransformer.createDynamicError`).
2. Load the template (module-level cache, invalidated on file mtime change).
3. Substitute `${ENV_VAR}` placeholders in string values from `process.env`.
4. Deep-clone, then inject: premiumize credentials `{ apiKey }` +
   `enabled: true`; `addonName = "Kevbox (Name)"`; synthetic UUID from name;
   kevbox-shaped self-manifest URL
   (`{baseUrl}/stremio/k/{name}/{apiKey}/manifest.json`).
5. Run the same `validateConfig(userData, { skipErrorsFromAddonsOrProxies:
   true, decryptValues: true })` as the stock middleware.
6. Attach `req.userData`, `next()`.

`syncUserDataUrls` is skipped (no DB user to sync).

### Touched upstream files (the entire merge surface)

| File | Change |
| --- | --- |
| `packages/server/src/app.ts` | +2 lines: import kevbox router, mount it before the `:uuid/:encryptedPassword` route |
| `packages/core/src/db/schemas.ts` | +1 optional field on the user-data schema: `selfManifestUrl` (string, optional) |
| `packages/core/src/main/index.ts` (line ~45) | Use `userData.selfManifestUrl` when present, else current interpolation |

Why the override is needed: `ctx.manifestUrl` is consumed by catalog
deep-links (`main/catalog.ts:46`); it is the **only** downstream consumer of
`uuid`/`encryptedPassword` (verified by grep across `packages/core`). The
`uuid` schema field is `z.string().uuid()`, hence a real (synthetic) UUID
rather than a sentinel string.

Explicitly out of scope / unaffected: `/chilllink/*` (separate client
protocol, unused by the family); per-user server state (library builtin,
cloud sync) — the template uses neither; `excludeUncached: true` and no
builtin presets mean no stream URLs route back through user-authenticated
paths.

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
  RPDB key → `${KEVBOX_RPDB_KEY}` (exact field set confirmed during
  implementation when `validateConfig` is run against the template).
- Template is loaded and validated **at server boot** — a broken edit fails
  the deploy loudly instead of failing at a family member's request.

Editing workflow: edit JSON → commit on `kevbox` → deploy. Every member picks
up the change on their next request — no reinstalls.

## 4. Branding & operator login (env only, no code)

```
ADDON_NAME=Kevbox
ADDON_ID=com.kevbox.stremio        # set once, BEFORE first family install
AIOSTREAMS_AUTH_REQUIRED=false     # configure page public
```

Note: the login only ever gated the configure page; kevbox install URLs
bypass it either way. Re-enabling it later does not affect the family.

## 5. Auto-update: `scripts/kevbox-update.sh` + timer

Runs on the VPS on a schedule (systemd timer preferred, cron acceptable):

1. `git fetch upstream --tags`; find the newest release tag (`v*`).
2. If already merged → exit 0 (idempotent).
3. `git merge <tag>` into `kevbox`; **on conflict: `git merge --abort`, log,
   exit non-zero** — never deploy a half-merge; conflicts wait for Kevin.
4. Rebuild + restart (Docker Compose build → up).
5. Health-check the running instance; on failure roll back to the previously
   deployed commit, rebuild, restart, log the failure.
6. On success push `kevbox` to `origin` so the fork stays the source of truth.

State (previously deployed commit, last log) kept in a file on the VPS.

## 6. Deployment on `persovps`

- Docker Compose building from the git checkout of `kevbox` (VPS already runs
  Docker). SQLite (default) on a volume — barely used since members are not
  DB rows, but required for boot.
- `.env` on the VPS: `SECRET_KEY` (64-char hex), `BASE_URL=https://streams.kevbox.dev`,
  the `KEVBOX_*` placeholder secrets, branding vars above.
- Reverse proxy: reuse whatever already fronts the VPS (nginx/caddy/traefik —
  inspected during implementation) and add a `streams.kevbox.dev` vhost with
  TLS. `.dev` requires HTTPS (HSTS preload).

## 7. Testing

- **Unit** (vitest, server package): template loader (placeholder
  substitution, missing-env failure, mtime cache invalidation); middleware
  (key injection, stable synthetic UUID per name, addonName format, name/key
  shape rejection).
- **Integration**: boot app with a fixture template; `GET
  /stremio/k/mum/{key}/manifest.json` → 200 with `name: "Kevbox (Mum)"`;
  malformed name/key → dynamic error response, not a 500.
- **Manual**: real install on one device against the VPS before family
  rollout.

## Risks & accepted trade-offs

- **PM key in URL plaintext**: fine over HTTPS in transit; Stremio syncs
  installed addon URLs to its account cloud — true of every config-in-URL
  Stremio addon (stock Torrentio included). Accepted for family use.
- **Per-member server state unavailable** (library, sync): unused by the
  template today; if wanted later, those members need real DB configs.
- **Merge surface**: 4 touched lines across 3 upstream files + 1 new file.
  Conflicts possible only if upstream rewrites those exact spots; auto-update
  aborts safely when that happens.

## Out of scope

- Multiple debrid services in the kevbox URL (PM only; revisit if a member
  switches services).
- Any frontend/SPA changes (configure UI untouched).
- Migrating existing watch history (separate concern; see the
  stremio-trakt-migration skill if needed).
