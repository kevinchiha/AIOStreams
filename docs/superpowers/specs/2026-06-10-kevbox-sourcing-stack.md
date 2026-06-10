# Kevbox Self-Hosted Sourcing Stack — Design Spec

**Date:** 2026-06-10
**Status:** Design FINAL — all open items resolved. Implementation plan:
[`docs/superpowers/plans/2026-06-10-kevbox-sourcing-stack.md`](../plans/2026-06-10-kevbox-sourcing-stack.md)

> Secrets policy: this repo is **public**. No secret values (API keys, passwords,
> `CONFIG_ACCESS_KEY`, Premiumize keys) appear in this doc, the plan, the template,
> or the compose file. All secrets live in the VPS `.env` (never in git).

## 1. Goal

Maximum ownership of the **sourcing layer**. Stop depending on overloaded shared
public addon instances; self-host the heavy candidate-gathering on the VPS; keep
the reliable pre-built-index addons as external fallbacks; keep Premiumize (debrid
cannot be self-hosted, and it is the reliable part).

How "cached on Premiumize" works (the constraint everything follows from):
Premiumize's cache is keyed by torrent hash. Every result is always two steps —
(1) gather candidate hashes for the title from *somewhere*, (2) ask Premiumize
which are cached. `excludeUncached=true` filters step 2's output; it cannot rescue
a step-1 scraper that timed out. So reliability lives entirely in step 1, and the
fix is to own step 1.

## 2. Decisions (all locked)

| # | Decision |
|---|----------|
| 1 | **Prowlarr + FlareSolverr** self-hosted, wired to Kevbox via the AIOStreams **Prowlarr builtin** (preconfigured-instance mode: `BUILTIN_PROWLARR_URL` / `BUILTIN_PROWLARR_API_KEY` env vars — no secrets in the template). |
| 2 | **MediaFusion self-hosted** (v6 stack: Rust API + worker, PostgreSQL 18, Redis — browserless/byparr skipped, see §3.3). The existing `mediafusion` preset repoints at it via a `${KEVBOX_MEDIAFUSION_URL}` template placeholder. |
| 3 | **Comet: dropped** — redundant once the Prowlarr builtin exists (Comet is a thin indexer-query + debrid-check layer). |
| 4 | **Knaben + TorrentGalaxy builtins: retired** — they are external sites, not self-hostable software. Their function moves into Prowlarr as indexers (FlareSolverr clears Cloudflare). |
| 5 | **TorrentsDB: KEEP as fallback** *(reversed from the draft design — see §3)*. |
| 6 | **Sootio: dropped** *(open item resolved — see §3)*, including its two `catalogModifications` entries. |
| 7 | **Zilean: SELF-HOSTED in this pass** *(open item resolved)* — `ipromknight/zilean` + PostgreSQL 17, wired via `BUILTIN_ZILEAN_URL`. |
| 8 | **Keep external fallbacks:** Torrentio, StremThru Torz, Peerflix, TorrentsDB. |
| 9 | **Premiumize stays** (unavoidable, reliable). `excludeUncached=true` stays. |
| 10 | **4 GB swap file** added to the VPS (currently zero swap) as OOM insurance. |

## 3. Research findings that changed or settled the draft design

1. **TorrentsDB is a pre-built hash index, not a live scraper.** The draft said
   "likely drop — Prowlarr overlaps". Wrong class: it's a Torrentio-fork-style
   index (Comet itself uses it as a backend source). Independent infrastructure →
   genuine redundancy for Torrentio. **Kept.**
2. **Sootio is a live meta-scraper.** Per request it re-queries Torrentio, Comet,
   StremThru, Zilean *and* ~11 torrent sites — its torrent coverage duplicates the
   stack while sitting in the flakiest addon class. Unique bits (debrid-cloud
   catalog, HTTP file-hosts) don't justify it. **Dropped.**
3. **MediaFusion v6 ≠ the old Mongo stack.** Current line is a Rust rewrite:
   API + background worker (same image, different command), **PostgreSQL 18**
   (not MongoDB), Redis. RAM is far lighter than the Python-era public instance
   (~0.8–1.3 GiB for the whole core stack). It has first-class Prowlarr
   integration (`PROWLARR_URL`/`PROWLARR_API_KEY`, `IS_SCRAP_FROM_PROWLARR`) and
   Zilean scraping (`IS_SCRAP_FROM_ZILEAN` + `ZILEAN_URL`) — both point at our
   own services. Its built-in public-site scrapers are disabled
   (`IS_SCRAP_FROM_PUBLIC_INDEXERS=false`), which means the official stack's
   **browserless + byparr (Chromium) containers are not needed at all** — CF-
   protected sites are covered via Prowlarr + FlareSolverr instead, saving
   ~0.7–2 GiB RAM. Pin `mhdzumair/mediafusion:6.0.0-beta.21` — `:latest`
   currently points at the old 5.5.x Python line. Worker imports IMDb datasets
   on first boot (several GB into Postgres; healthcheck `start_period: 20m`).
4. **MediaFusion playback URLs route through its `HOST_URL`**
   (`{host_url}/streaming_provider/…/playback/…`), so the self-hosted instance
   **must be publicly reachable** by the family's Stremio clients → new public
   vhost (`mf.kevbox.dev`) + TLS, with access logs off (URLs embed tokens).
5. **AIOStreams' Torznab builtin prefers `imdbid` queries** when the indexer
   advertises support → Zilean's IMDB import matching stays **enabled**
   (`Imdb.UseLucene=false` avoids its ~3 GB RAM cost).
6. **Template/env mechanics:** `kevbox.config.json` supports `${ENV_VAR}`
   placeholders; `kevboxRepoTemplate.test.ts` boot-checks the real template, so
   the preset lineup change is test-driven. The template is **bind-mounted with
   instant mtime reload** on the VPS — so the new template must only land there
   *after* `BUILTIN_PROWLARR_*` and `KEVBOX_MEDIAFUSION_URL` exist in `.env`
   (the plan splits infra and template into separately-deployable commits).

## 4. Target architecture

```
                       ┌──────────────────────────────────────────────────────┐
                       │ VPS — one compose project, pinned subnet 172.30/16    │
                       │                                                       │
Stremio ─▶ Kevbox ────▶│ AIOStreams (kevbox)                                   │
(family)  (aggregator) │   ├─▶ Prowlarr builtin ─▶ prowlarr:9696 ─┬─▶ flaresolverr:8191
                       │   │                                      └─▶ TPB, YTS, EZTV, 1337x,
                       │   │                                          TheRARBG, Knaben, TG…
                       │   ├─▶ Torznab builtin ──▶ zilean:8181 ── zilean-postgres
                       │   │                        (DMM hashlist index, self-hosted)
                       │   └─▶ mediafusion preset ─▶ https://mf.kevbox.dev (nginx)
                       │                              └─ mediafusion api+worker
                       │                                 ├─ mediafusion-postgres
                       │                                 ├─ mediafusion-redis
                       │                                 └─ scrapes: prowlarr + zilean
                       │                                    (public-site scrapers OFF)
                       └──────────────────────┬────────────────────────────────┘
                                              │ cache-check (hashes)
                                              ▼
                                        Premiumize (external, reliable)
External fallbacks kept: Torrentio · StremThru Torz · Peerflix · TorrentsDB
Dropped: Comet · Sootio · in-process Knaben & TorrentGalaxy builtins
```

## 5. Final preset lineup (`kevbox.config.json`)

| preset `type` | instanceId | Disposition |
|---|---|---|
| `torrentio` | 001 | KEEP (fallback index) |
| `mediafusion` | a04 | REPOINT → `${KEVBOX_MEDIAFUSION_URL}` (self-hosted) |
| `stremthruTorz` | cf3 | KEEP (fallback index) |
| `torrents-db` | 6ea | KEEP (fallback index) |
| `zilean` | 249 | KEEP — served by self-hosted instance via `BUILTIN_ZILEAN_URL` |
| `peerflix` | 4ea | KEEP (fallback index) |
| `prowlarr` | 9b2 | **ADD** (builtin, preconfigured-instance mode) |
| `comet` | 782 | **REMOVE** |
| `sootio` | 2c2 | **REMOVE** (+ its 2 catalogModifications entries) |
| `knaben` | 7c4 | **REMOVE** (→ Prowlarr indexer) |
| `torrent-galaxy` | 7f3 | **REMOVE** (→ Prowlarr indexer) |

## 6. New environment variables (VPS `.env` — names only, values never in git)

| Var | Purpose |
|---|---|
| `BUILTIN_PROWLARR_URL` | `http://prowlarr:9696` (docker-network URL) |
| `BUILTIN_PROWLARR_API_KEY` | Prowlarr API key (secret) — consumed by the AIOStreams builtin |
| `PROWLARR_API_KEY` | Same value — consumed by MediaFusion + compose interpolation |
| `BUILTIN_ZILEAN_URL` | `http://zilean:8181` |
| `ZILEAN_POSTGRES_PASSWORD` | Zilean's Postgres password (secret) |
| `KEVBOX_MEDIAFUSION_URL` | `https://mf.kevbox.dev` — substituted into the template |
| `MEDIAFUSION_SECRET_KEY` | MediaFusion crypto key (secret, `openssl rand -hex 16`) |
| `MEDIAFUSION_API_PASSWORD` | MediaFusion admin/scraper API password (secret) |
| `MEDIAFUSION_POSTGRES_PASSWORD` | MediaFusion's Postgres password (secret) |

## 7. Risks / watch items

- **RAM:** new stack ≈ 2–3 GiB steady state (Prowlarr ~0.2, FlareSolverr ~0.3,
  Zilean stack ~1–1.5, MediaFusion stack ~0.8–1.3) vs ~8.9 GiB available + new
  4 GB swap. Transient spikes during Zilean's first DMM+IMDb import and
  MediaFusion's first-boot IMDb import — avoid running both first imports
  simultaneously. `firecrawl-api` (cap 8 GiB) remains the reclaim option.
- **Zilean first import:** several hours; ~10 GB Postgres disk (give it 15–20 GB
  headroom; 150 GB free — fine). MediaFusion's Postgres wants another 5–10 GB.
  Kevbox keeps using the public Zilean until `BUILTIN_ZILEAN_URL` is flipped,
  so there is no coverage gap during import.
- **Cutover sequencing:** template lands on the VPS only at cutover (see §3.6),
  after all env vars + services are live. Until then the family keeps the
  current lineup minus nothing.
- **Stremio manifest caching:** dropping Sootio removes its catalogs from member
  manifests; clients may show stale catalog rows until a reinstall (harmless).
- **IPv6-first DNS hang (Node-specific):** kevbox already carries
  `--dns-result-order=ipv4first`. New services are .NET/Rust/Python and not
  expected to be affected — but check first if any new container times out on
  outbound fetches.
- **MediaFusion image pin:** `mhdzumair/mediafusion:6.0.0-beta.21` (the tag its
  official compose pins as of 2026-06-10). Bump deliberately, never `latest`.
