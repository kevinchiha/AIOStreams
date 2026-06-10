# Kevbox Self-Hosted Sourcing Stack — Design Spec

**Date:** 2026-06-10 (rev 2: 2026-06-11 — revised per the gap audit:
[`docs/superpowers/reviews/2026-06-10-kevbox-sourcing-stack-gap-audit.md`](../reviews/2026-06-10-kevbox-sourcing-stack-gap-audit.md))
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
| 2 | **MediaFusion self-hosted, internal-only** (v6 stack: Rust API + worker, PostgreSQL 18, Redis — browserless/byparr skipped, see §3.3). The existing `mediafusion` preset repoints at it via a `${KEVBOX_MEDIAFUSION_URL}` template placeholder = `http://mediafusion:8000` on the compose network — **no public vhost** (rev 2 reversal, see §3.4). Kevbox resolves MF's raw infoHash results through Premiumize via a template `serviceWrap` block. |
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
   own services. **Caveat (rev 2):** the `IS_SCRAP_FROM_*` flags gate only the
   live-search path — the image also seeds always-on spider/DMM cron rows in
   Postgres (sport-video every 20 min, tamilmv 3 h, hourly DMM-hashlist
   ingestion, …) that would scrape public torrent sites directly from the VPS
   IP and duplicate Zilean's ~10 GB corpus into MF's Postgres; the plan
   disables those rows after first boot (Task 9 Step 3) and sets
   `DMM_HASHLIST_*_COMMITS_PER_RUN=0` as a second guard. With that done no
   public-site scraping happens, so the official stack's **browserless +
   byparr (Chromium) containers are not needed at all** — CF-protected sites
   are covered via Prowlarr + FlareSolverr instead, saving ~0.7–2 GiB RAM.
   Pin `mhdzumair/mediafusion:6.0.0-beta.21` — `:latest` is a *stale v6 beta*
   (digest-identical to 6.0.0-beta.7) and moves unpredictably. The IMDb
   dataset import is seeded **disabled** upstream and never runs by itself —
   the plan triggers it deliberately (Task 9 Step 4, several GB into
   Postgres); the api container's healthcheck `start_period` is 2 m (boot
   only runs sqlx migrations).
4. **No public exposure needed (rev 2 — reverses the draft).** The playback-URL
   rationale held only for the old Python line, whose middleware converts the
   `encoded_user_data` header into a path secret. In the Rust v6 line the
   public stream routes pass an **empty** secret and every formatter guards
   playback-URL emission with `if !secret_str.is_empty()` — so via AIOStreams'
   header flow MF returns **raw torrent infoHashes**, never `HOST_URL`
   playback URLs. Kevbox therefore reaches MF privately
   (`KEVBOX_MEDIAFUSION_URL=http://mediafusion:8000`) and resolves the hashes
   through Premiumize itself via a template `serviceWrap` block scoped to the
   mediafusion preset (without it the hashes would surface as unplayable raw
   P2P streams). MF's catalog/meta URLs build on `HOST_URL`, so the template
   trims the preset to `resources: ["stream"]`. No DNS record, no nginx vhost,
   no TLS cert.
5. **AIOStreams' Torznab builtin prefers `imdbid` queries** when the indexer
   advertises support → Zilean's IMDB import matching stays **enabled**
   (`Imdb.UseLucene=false` avoids its ~3 GB RAM cost).
6. **Template/env mechanics:** `kevbox.config.json` supports `${ENV_VAR}`
   placeholders; `kevboxRepoTemplate.test.ts` boot-checks the real template, so
   the preset lineup change is test-driven. The template is bind-mounted as a
   **single file, and Docker pins the inode** — git operations replace files
   via unlink+create, so a `git pull`/`revert` never reaches the running
   container by itself; every git-driven template change requires
   `up -d --force-recreate kevbox` (mtime hot-reload only applies to in-place
   writes). The new template must only land *after* `BUILTIN_PROWLARR_*` and
   `KEVBOX_MEDIAFUSION_URL` exist in `.env` (the plan splits infra and
   template into separately-deployable commits).
7. **First-request behavior (cache warming, rev 2):** the Prowlarr builtin
   issues ONE aggregated Prowlarr search across all chosen indexers, so the
   slowest indexer (a cold Cloudflare solve: 10–60 s) gates the whole call
   against the preset's 15 s budget; on a miss the handler keeps running and
   caches results for a week, so the *second* request succeeds. Family-visible
   effect: a fresh title may need a second open before Prowlarr rows appear.
   Mitigation lives in Prowlarr settings (keep CF-tagged indexers few, bound
   their query timeouts). MediaFusion is immune for kevbox traffic:
   `useCachedResultsOnly: true` maps to `live_search_streams: false`, so MF
   always answers from its DB within the 10 s preset timeout
   (`PROWLARR_LIVE_TITLE_SEARCH` only affects the never-taken live path).

## 4. Target architecture

```
                       ┌──────────────────────────────────────────────────────┐
                       │ VPS — one compose project, pinned subnet 172.30/16    │
                       │                                                       │
Stremio ─▶ Kevbox ────▶│ AIOStreams (kevbox)                                   │
(family)  (aggregator) │   ├─▶ Prowlarr builtin ─▶ prowlarr:9696 ─┬─▶ flaresolverr:8191
                       │   │                                      └─▶ TPB, YTS, EZTV, 1337x,
                       │   │                                          Knaben, TorrentGalaxy…
                       │   ├─▶ Torznab builtin ──▶ zilean:8181 ── zilean-postgres
                       │   │                        (DMM hashlist index, self-hosted)
                       │   └─▶ mediafusion preset ─▶ http://mediafusion:8000 (internal,
                       │                              └─ mediafusion api+worker  serviceWrap)
                       │                                 ├─ mediafusion-postgres
                       │                                 ├─ mediafusion-redis
                       │                                 └─ scrapes: prowlarr + zilean
                       │                                    (seeded spider crons disabled)
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
| `mediafusion` | a04 | REPOINT → `${KEVBOX_MEDIAFUSION_URL}` (self-hosted, docker-internal; `resources: ["stream"]`; hashes resolved via top-level `serviceWrap`) |
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
| `KEVBOX_MEDIAFUSION_URL` | `http://mediafusion:8000` (docker-network URL — never public) — substituted into the template |
| `MEDIAFUSION_SECRET_KEY` | MediaFusion crypto key (secret, `openssl rand -hex 16`) |
| `MEDIAFUSION_API_PASSWORD` | MediaFusion admin/scraper API password (secret). **Dual-consumed:** AIOStreams core reads this exact env name too and sends it as `api_password` on every mediafusion-preset request — both consumers must share one value. If the preset is ever pointed at a third-party instance (rollback), treat the value as exposed and rotate. |
| `MEDIAFUSION_POSTGRES_PASSWORD` | MediaFusion's Postgres password (secret) |

## 7. Risks / watch items

- **RAM:** new stack ≈ 2–3 GiB steady state (Prowlarr ~0.2; FlareSolverr ~0.3
  idle but ~0.5 GiB per *concurrent* CF solve — keep the cf-tagged indexer
  count small; Zilean stack ~1–1.5, MediaFusion stack ~0.8–1.3). Host measured
  2026-06-11: 15.6 GiB total / ~8.6 GiB available, `firecrawl-api` baseline
  ~2.2 GiB under its 8 GiB cap. 4 GB swap as insurance, and the burst-prone
  containers carry `mem_limit`s so a runaway import OOMs its own container
  (which restarts and resumes) instead of the host. Don't run Zilean's first
  DMM import and the manually-triggered MediaFusion IMDb import
  simultaneously. Lowering `firecrawl-api`'s cap remains the reclaim option.
- **Zilean first import:** several hours; ~10 GB Postgres disk (give it 15–20 GB
  headroom). MediaFusion's Postgres wants another 5–10 GB once its IMDb import
  is triggered. The plan pre-flights `df -h /var/lib/docker` (≥ 40 GB free
  go/no-go) before starting, rather than assuming the disk figure.
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
  official compose pins as of 2026-06-10). `:latest` is a *stale v6 beta*
  (currently digest-identical to 6.0.0-beta.7) and moves unpredictably — bump
  deliberately, never `latest`.
- **Backups:** zilean-postgres and mediafusion-postgres are deliberately NOT
  backed up — both rebuild from public sources (DMM hashlists / IMDb
  datasets). The exception is `prowlarr-config` (API key, auth, FlareSolverr
  proxy, hand-added indexers — un-re-importable manual state): snapshot it
  after Task 6 and after future indexer changes.
- **Silent worker death:** `mediafusion-worker` alone runs every MF cron/queue
  job and exposes no health surface; if it wedges, the API serves
  progressively staler results behind a green `/health`. Watchdog = staleness
  probe on `cron_jobs.last_enqueued_at` (plan Task 11 Step 3).
