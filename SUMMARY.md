# Kevbox — build & deployment summary

**Date:** 2026-06-10 · **Branch:** `kevbox` · **Status:** ✅ deployed & live at `https://streams.kevbox.dev`

> Companion docs: **[KEVBOX.md](KEVBOX.md)** (operator manual — how to run it),
> the design spec (`docs/superpowers/specs/2026-06-10-kevbox-design.md`) and the
> implementation plan (`docs/superpowers/plans/2026-06-10-kevbox.md`). This file
> is the *what-we-did* snapshot.

## Goal

One shared AIOStreams config, installed per family member by pasting a single
URL where only the member's name and Premiumize key differ — plus Torrentio at
the top, Kevbox branding, and a VPS deployment under `streams.kevbox.dev`.

```
https://streams.kevbox.dev/stremio/k/<member>/<premiumizeApiKey>/manifest.json
```

## How it works

A new **stateless** route `/stremio/k/:name/:apiKey` mirrors the stock
authenticated Stremio router but builds `UserData` from a repo-versioned JSON
template (`kevbox.config.json`) instead of a DB lookup. Per request the
middleware: validates the name/key shape, checks the name against the
`KEVBOX_MEMBERS` allowlist, injects the member's Premiumize key + a synthetic
per-name UUID + the `Kevbox (Name)` addon name + the operator config-access key,
then runs the same `validateConfig` as the stock path. No DB writes, no per-member
config to maintain.

## What was built

**Merge surface — 6 upstream source files, tiny diffs** (kept minimal so upstream
syncs rarely conflict):

| File | Change |
|---|---|
| `core/src/db/schemas.ts` | `+1` — optional `selfManifestUrl` on `UserData` |
| `core/src/main/index.ts` | use `selfManifestUrl` for catalog deep-links |
| `core/src/utils/fieldMeta.ts` | `+1` — `selfManifestUrl` in `IgnoredKeys` |
| `server/src/app.ts` | mount the kevbox router before `:uuid` |
| `server/src/middlewares/errors.ts` | rate-limit error stream for `k/` URLs |
| `server/src/server.ts` | fail-loud, schema-validating boot check |

**New fork-local files:** the router/middleware (`routes/stremio/kevbox.ts`),
two utils (`kevboxTemplate.ts`, `kevboxUserData.ts`) + a shared regex module,
the golden template (`kevbox.config.json`), `compose.kevbox.yaml`, KEVBOX.md,
and the test suites.

## Key decisions

- **Stateless synthetic config** (no DB users per member) — onboarding = add a
  name to `KEVBOX_MEMBERS` + paste a URL.
- **`KEVBOX_MEMBERS` allowlist** closes the open-relay hole (unknown names get a
  friendly Stremio error). *Caveat:* it gates **names, not keys** — use
  non-obvious member names.
- **Auth ON** (`AIOSTREAMS_AUTH_REQUIRED=true` + `CONFIG_ACCESS_KEY`) blocks
  anonymous DB-config creation; the middleware injects the key per request so
  family URLs are unaffected.
- **Auto-update dropped** (operator decision) — unattended upstream merges risked
  breaking the fork. Updates are **manual** via the KEVBOX.md flow.
- **MediaFlow proxy + RPDB disabled** — Premiumize links aren't IP-locked (so the
  proxy only cost VPS bandwidth) and RPDB is just rating badges. Result: the
  template needs **zero secrets**.
- **Fail-loud boot check** — a broken/drifted template fails `docker compose up`
  (offline schema validation) instead of 400-ing every family request.

## Verification

- **Tests:** server **47** + frontend **281** passing (`pnpm test`, exit 0).
  Includes unit (template loader, UserData builder, allowlist parser, rate-limit
  regex) and integration tests that boot the real built server (member-branded
  manifest, allowlist rejection, malformed key, `/configure` redirect, all six
  resources mounted, fail-loud boot, template-load-failure).
- **Adversarial review:** multi-agent review (9 findings, all verified, none
  critical/high) → low-risk fixes applied (error-message passthrough, offline
  `instanceId` boot check, mount-sync guards, test-coverage gaps).
- **Bug caught & fixed:** the export carried a `debridge` service id this fork's
  schema rejects (would have 400'd every install) — removed, and the boot check
  hardened so such drift fails the deploy.

## Deployment (live)

- **VPS** persovps · container `kevbox` (`compose.kevbox.yaml`, `127.0.0.1:3127`,
  `restart: unless-stopped`, healthy) · repo `/opt/kevbox/AIOStreams`.
- **nginx** vhost `streams.kevbox.dev` → container, **`access_log off`** (PM keys
  in URLs never hit disk), Let's Encrypt TLS + HTTP→HTTPS redirect.
- **Verified end-to-end:** HTTPS health 200; manifest `Kevbox (Kevin)` with
  `[stream, catalog, meta]`; allowlist rejects non-members live.

## Remaining (operator-only)

1. Real playback test with your actual Premiumize key in a Stremio client.
2. Onboard family: add names to `KEVBOX_MEMBERS` (non-obvious) → `compose up -d`
   → send each member their URL.
3. Optional: re-enable RPDB (free key) for rating posters; re-enable MediaFlow
   only if you ever see playback fail across devices.
