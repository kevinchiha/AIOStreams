# Kevbox Sourcing Stack — Gap Audit

**Date:** 2026-06-10
**Subject:** [`specs/2026-06-10-kevbox-sourcing-stack.md`](../specs/2026-06-10-kevbox-sourcing-stack.md) + [`plans/2026-06-10-kevbox-sourcing-stack.md`](../plans/2026-06-10-kevbox-sourcing-stack.md)
**Method:** 6-lens multi-agent audit (codebase wiring, compose, ops sequencing, security, external-software research, resources/failure modes), every finding adversarially verified by 2 independent agents. 43 raw findings → **21 confirmed** (both verifiers agree), **11 disputed** (1-1 split, adjudicated below), **9 unverified** (verifiers hit the API spend limit — full finding text recovered from transcripts; treat as credible but re-check the cited upstream sources), **2 refuted**.

> **Verification update (2026-06-11):** the unverified findings were re-run through a dedicated 16-agent adversarial workflow (run `wf_7b1736b9-c74`; the 9th was a duplicate of the already-confirmed debug-log finding and was skipped). Verdicts:
> - **§0 public exposure — CONFIRMED** (both verifiers, high confidence, against the tagged Rust source). Bonus finding: without a template `serviceWrap` block, MF's infoHash results wouldn't be Premiumize-resolved at all — they'd surface as raw P2P. Task 8 deleted; MF is internal-only (`http://mediafusion:8000`), preset trimmed to `resources: ["stream"]`, top-level `serviceWrap {enabled, presets:["a04"], services:["premiumize"]}` added.
> - **§4.2 seeded cron spiders/DMM ingestion — CONFIRMED** (new plan Task 9 Step 3 disables the rows; `DMM_HASHLIST_*_COMMITS_PER_RUN=0` guard added).
> - **§4.1 IMDb import never runs — CONFIRMED** (seeded `enabled=false` upstream; new Task 9 Step 4 triggers it deliberately).
> - **§5.1 aggregated-search first-hit-miss — CONFIRMED** (documented in spec §3.7 + Task 11 expectations).
> - **§5.3 silent worker death — CONFIRMED** (medium; Task 11 Step 3 now mandatory with a `cron_jobs.last_enqueued_at` staleness probe — note: the Prometheus option doesn't work at this tag, worker job metrics aren't HTTP-served).
> - **§5.4 disk pre-flight — CONFIRMED** (added to Task 5 Step 2 + Task 9 note).
> - **§5.2/RAM overcommit — DISPUTED → adopted as hardening:** a verifier measured the actual host: **15.6 GiB total RAM** (the spec's 8.9 GiB was *available*, not total), firecrawl-api baseline ~2.2 GiB. mem_limits added to burst-prone containers anyway (contained OOM ≫ host OOM roulette).
> - **§4.3 MF live-search timeout — REFUTED** (good news): `useCachedResultsOnly: true` → `live_search_streams: false`, so kevbox traffic never triggers the inline live fan-out; `PROWLARR_LIVE_TITLE_SEARCH` is inert dead config for this flow. No action beyond a doc note.
>
> All accepted fixes are folded into the spec (rev 2) and plan (rev 2). The completeness-critic phase from the original run was never executed (spend limit) and was deliberately not re-run.

---

## 0. Decide first — the public MediaFusion vhost may be unnecessary ⚠️ UNVERIFIED, HIGH

The single biggest potential simplification, and it gates several other findings:

The spec's justification for `mf.kevbox.dev` (§3.4: "playback URLs route through HOST_URL, so it must be publicly reachable") **may not hold for the kevbox→MF flow**. The mediafusion preset calls MF with an `encoded_user_data` *header* and an **empty path secret** (`packages/core/src/presets/mediafusion.ts:399-428`). In MF 6.0.0-beta.21, every playback-URL formatter is guarded by `if !secret_str.is_empty()` (`routes/stream.rs`) — with an empty secret MF returns raw torrent infoHashes, and AIOStreams resolves Premiumize itself (it already holds the key and runs `excludeUncached`).

If that's right, `KEVBOX_MEDIAFUSION_URL=http://mediafusion:8000` (docker-internal) works, and **Task 8 (DNS/nginx/TLS), the public abuse surface, and the email leak all disappear**.

**Action before building Task 8:** start the MF stack (Task 9 can precede Task 8 — nothing in Task 9 needs the vhost except the public-manifest curl), point a test config at the internal URL, request a movie through the member URL, and check whether any returned stream URL references mf.kevbox.dev. None → go internal, delete Task 8. Some → keep the vhost but apply §3 hardening below.

---

## 1. Must-fix in Phase A (local commits)

### 1.1 Task 2 breaks `kevboxIntegration.test.ts` (CONFIRMED — was high, adj. medium)
Plan Task 2 Step 5's claim "the other kevbox tests use fixtures, not the repo template" is false. The "kevbox real template (schema-drift guard)" suite (`packages/server/src/kevboxIntegration.test.ts:136-163`) boots the built server against the repo `kevbox.config.json` with `DUMMY_KEVBOX_ENV` (`:24-28`) that lacks `KEVBOX_MEDIAFUSION_URL`. The new `${KEVBOX_MEDIAFUSION_URL}` placeholder makes `substituteEnvPlaceholders` throw (`kevboxTemplate.ts:45-48`) → server exits 1 → test times out. It passes today **only** because `describe.skipIf(!built)` skips when `dist/` is absent — it detonates on the next `pnpm build && pnpm test` (KEVBOX.md's mandatory upstream-merge flow), weeks later, as a confusing timeout.
**Fix:** add `KEVBOX_MEDIAFUSION_URL: 'https://mediafusion.example.com'` to `DUMMY_KEVBOX_ENV`, include the file in the Task 2 commit, and run `pnpm build && pnpm -F server test` once in Step 5 so the guard actually exercises the new template.

### 1.2 Task 1 Step 3 local compose validation fails as written (CONFIRMED — low)
`kevbox` declares `env_file: .env` (compose.kevbox.yaml:8-9); no local `.env` exists; compose hard-fails (`env file ... not found`) — empirically verified, exit 1. The new YAML itself validates cleanly once `.env` exists.
**Fix:** prepend `[ -f .env ] || touch .env` to the step (or switch to the optional long-form `env_file` syntax); update the Expected text.

### 1.3 MediaFusion api healthcheck: `start_period: 20m` rationale is wrong (CONFIRMED — low)
The IMDb import is a **worker** task (`ImdbDatasetImport` registered only in `worker.rs`); the api only runs sqlx migrations. Upstream pins the api healthcheck at `start_period: 30s`. A genuinely broken api (bad `POSTGRES_URI`/`SECRET_KEY`) sits masked in `health: starting` for 20 minutes while the vhost 502s, and Task 9 Step 2's "wait, don't restart" compounds it.
**Fix:** api `start_period: 2m`, comment "first boot runs sqlx migrations"; move the long-wait language to the worker. See also §4.1 — the import may not run at all.

### 1.4 Stripped postgres `command` drops `shared_preload_libraries=pg_stat_statements` (CONFIRMED — low)
Boot still succeeds (migration 0014 is defensive), but MF's admin DB slow-query routes will error. Fixing later costs a postgres restart.
**Fix:** add `-c shared_preload_libraries=pg_stat_statements` to the mediafusion-postgres command, or note the diagnostics are intentionally off.

### 1.5 `shm_size` halved vs upstream for no RAM saving (DISPUTED → adopt, trivial)
tmpfs is lazily allocated — `shm_size: 1g`→`2g` (zilean-postgres) and `256mb`→`512mb` (mediafusion-postgres) costs nothing idle and removes a "could not resize shared memory segment" risk during the bulk imports. One verifier argued the demand side was also halved; restoring upstream values is free either way.

---

## 2. Must-fix in Phase B (VPS steps)

### 2.1 The "Fetched N preconfigured indexers" greps can never succeed (CONFIRMED ×3 — was high, adj. medium)
Task 6 Step 7 and Task 10 Step 2 grep for a `logger.debug` line (`builtins/prowlarr/addon.ts:73`), but default `LOG_LEVEL` is `info` (`utils/env.ts:218-221`) and nothing sets it on the VPS. The grep finds nothing even when wiring is perfect — false-negative debugging spiral at Task 6, unnecessary-rollback bait at cutover. (Also: "N = count you enabled" actually describes the separate `Set N` line.)
**Fix (pick one):** (a) promote the two lines to `logger.info` in the Phase A commit (cleanest); (b) `LOG_LEVEL=debug` in `.env` for the rollout window; (c) replace the check with behavior: Task 6 Step 6's authenticated search curl + absence of a Prowlarr-init error line, with the real proof deferred to Task 10 Step 3's stream counts.

### 2.2 Task 10 pre-flight contradicts Task 7's import gate (CONFIRMED — was high, adj. medium)
Step 1 requires `BUILTIN_ZILEAN_URL` among "all four lines", but Task 7 Step 3 only adds it after the multi-hour import, and the spec promises cutover-before-flip works (Task 10 Step 3 even says Zilean "counts either way"). As written: cutover stalls hours for no reason, or the operator adds the var early and flips the family onto a half-imported index — the exact coverage gap the spec rules out. The template never references `BUILTIN_ZILEAN_URL` (builtin env with a public default, `config/schema/builtins.ts:519-527`).
**Fix:** require only the three vars cutover needs; add "BUILTIN_ZILEAN_URL intentionally absent until Task 7 Step 3 — do NOT add early."

### 2.3 "Instant mtime reload" is wrong for git-driven updates — rollback note misleads (CONFIRMED — medium)
The single-FILE bind mount pins the **inode**; `git pull/revert/merge` replace files via unlink+create (new inode), so the running container keeps the OLD template until recreated (verified empirically by a verifier with `mount --bind`). Cutover survives only because Task 10 Step 2 happens to recreate immediately. The rollback note ("the bind-mounted template reverts on next request") is false as written — an operator would believe a broken template was rolled back while members still get it.
**Fix:** make `up -d --force-recreate kevbox` a mandatory part of every git-driven template change (especially the rollback note); reword the spec's reload claims (mtime reload applies to in-place writes only), or bind-mount the containing directory.

### 2.4 `MEDIAFUSION_API_PASSWORD` is dual-consumed — undocumented name coincidence is load-bearing (CONFIRMED — medium)
AIOStreams core also reads `MEDIAFUSION_API_PASSWORD` (`config/schema/presets.ts:172-179`) and the preset embeds it as `api_password` in every request to whatever URL the template points at (`presets/mediafusion.ts:559`). Auth to the self-hosted instance works only because the names happen to match. Worse: from Task 6 Step 7 (first recreate with new `.env`) until cutover, the OLD template still points at `mediafusion.elfhosted.com` — kevbox sends the fresh secret to the third-party instance; same under the documented rollback.
**Fix:** document the dual consumption in spec §6/KEVBOX.md (values must match); treat the value as exposed if rollback to elfhosted is used (rotate after).

### 2.5 TheRARBG cannot be added — removed from Prowlarr's catalog Oct 2025 (CONFIRMED — low)
Remove the row from Task 6 Step 5 and the spec §4 diagram (Knaben + BitSearch cover the overlap). The TorrentGalaxy hedge resolves to `TorrentGalaxyClone` in the current catalog.

### 2.6 Prowlarr API-key extraction: add a guard (DISPUTED → adopt the cheap fix)
One verifier empirically showed the key lands ~2s after start and an empty key fails loudly at Step 6; the other showed the builtin silently early-returns on empty key and `jq length` on a 401 body can spuriously pass. The 2-line insurance is worth it: wait until `config.xml` contains `<ApiKey>`, then `[[ "$PROWLARR_KEY" =~ ^[0-9a-f]{32}$ ]] || exit 1` before appending to `.env`.

### 2.7 prowlarr-config volume holds the only unrecoverable manual state — no backup step (CONFIRMED — low)
API key, forms-auth, FlareSolverr proxy, ~13 hand-added indexers. Zilean/MF data rebuilds from public sources; this doesn't.
**Fix:** end Task 6 with a volume snapshot (`docker run --rm -v prowlarr-config:/config -v /opt/kevbox/backups:/backup alpine tar czf /backup/prowlarr-config-$(date +%F).tgz -C /config .`) — store with `.env`-grade perms (contains the key). Also add the one-line backup-posture note to spec §7: zilean/MF postgres deliberately not backed up (re-importable); prowlarr-config is the exception.

### 2.8 uptime-kuma `docker network connect` doesn't survive recreation (CONFIRMED — low)
Runtime-only attachment → after either side is recreated, internal monitors false-alarm with DNS errors.
**Fix:** declare the kevbox network as `external: true` in uptime-kuma's own compose and attach the service there; or add the caveat to Task 11/KEVBOX.md.

---

## 3. Public-surface hardening (only if §0 says the vhost must stay) 

### 3.1 Blanket `location /` exposes MF's no-auth public surface (CONFIRMED — was high, adj. medium)
`api_password` gates debrid playback but NOT: `/manifest.json`, `/catalog/*`, `/meta/*`, the no-secret `/stream/*` handlers (return infoHash/P2P streams), `/configure`, `POST /encrypt-user-data`, and `/api/v1/instance/app-config` (exempt from auth middleware — returns `contact_email`). Net: anyone who finds the host gets an open torrent meta-search that drives your Prowlarr/Zilean scrapes, plus Kevin's Gmail.
**Fix:** restrict the vhost to the paths the integration needs; 403 `/configure`, `/encrypt-user-data`, `/api/v1/`; at minimum block `/configure` and `/api/v1/instance/app-config`.

### 3.2 No throttling anywhere + `access_log off` = unauditable open surface (CONFIRMED — low)
MF's in-app rate limiter is inactive on private instances (`rate_limit_middleware.rs` returns early), and the plan disables it anyway; the vhost has no `limit_req`; `access_log off` removes the forensic trail.
**Fix:** nginx `limit_req_zone` on the vhost; consider sampled or path-only logging (the no-secret public routes leak nothing in the request line).

### 3.3 Personal Gmail as public contact (CONFIRMED — low)
`CONTACT_EMAIL: kevin.chiha@gmail.com` is served by `/api/v1/instance/app-config` and invites DMCA/abuse mail to your real identity (the address is already public in git, so not a new *secret* leak).
**Fix:** role alias (e.g. `abuse@kevbox.dev`), or `admin@example.com` which MF filters out. Moot if §0 goes internal.

---

## 4. MediaFusion behavior corrections ⚠️ UNVERIFIED (cite upstream 6.0.0-beta.21 sources — spot-check before relying)

### 4.1 The IMDb "first-boot import" never runs — it's seeded DISABLED (medium)
Migration 0011 seeds `imdb_dataset_import` with `enabled=false`; nothing auto-enqueues it. Task 9 Step 1's "watch the IMDb import kick off" watches for nothing; the resource-sequencing worry about racing the two first imports is moot as written; MF runs without the dataset (degraded title→IMDb matching) and nobody decided that.
**Fix:** add an explicit, deliberately-timed trigger step to Task 9 (admin API `POST /api/v1/admin/scrapers/imdb-dataset/run`, or `mediafusion-worker --run-job imdb_dataset_import`) after Zilean's import finishes — or decide to skip it and fix the spec language + disk estimate.

### 4.2 Seeded cron spiders + DMM ingestion ignore `IS_SCRAP_FROM_*` — "public scrapers OFF" is false (high)
Migration 0005 seeds `spider_sport_video` (every 20 min!), `spider_formula_ext` (30 min), `spider_movies_tv_ext` (hourly), tamilmv/tamilblasters/wwe/ufc/eztv_rss/arab_torrents and nyaa/animetosho/subsplease registry crawls — all `enabled=true`, and the Rust job pipeline never checks `is_scrap_from_public_indexers` (that flag only gates live search). The hourly `dmm_hashlist` cron likewise ingests the whole DMM corpus into MF's postgres — duplicating Zilean's ~10 GB on the same disk and competing for the same unauthenticated GitHub quota. The `DISABLE_<SPIDER>_SCHEDULER` vars exist only in docs/python-deprecated. Net: steady direct scraping of public torrent sites from the family VPS IP, on schedules, contradicting spec §3.3's load-bearing claim.
**Fix:** after first boot, disable the unwanted rows (`UPDATE cron_jobs SET enabled=false WHERE name LIKE 'spider_%' OR name IN ('dmm_hashlist', ...)`) keeping `background_search`/`prowlarr_feed`/cleanup jobs; verify with `SELECT name FROM cron_jobs WHERE enabled`; set `DMM_HASHLIST_COMMITS_PER_RUN=0` + backfill=0 as belt-and-braces; correct spec §3.3.

### 4.3 `PROWLARR_LIVE_TITLE_SEARCH=true` can never finish inside the preset's 10s timeout (high)
MF v6 runs live scrapes **inline** in `/stream` (its own route timeout default is 120s "longer than the slowest scraper"; `prowlarr_immediate_max_process_time` default 15s). Kevbox aborts the preset at 10s → MF contributes zero streams for any cache-expired title, while the server-side fan-out still executes — and kevbox's own Prowlarr builtin queried the same 13 indexers in the same second. Double load, duplicate FlareSolverr solves, no benefit on first hit.
**Fix:** set `PROWLARR_LIVE_TITLE_SEARCH: "false"` and rely on `background_search` (enabled by default — verify it survives the §4.2 cron cleanup) so MF answers from its DB within 10s and kevbox's builtin remains the sole live-search path. Document the role split in spec §3.3.

---

## 5. First-request latency + resilience (partially disputed — adjudicated real)

### 5.1 Prowlarr first-search behavior is undertuned and undocumented (DISPUTED + UNVERIFIED cluster)
The builtin makes **one aggregated** `/api/v1/search` call across all chosen indexers (`builtins/prowlarr/addon.ts:209-227`) with internal timeout 30s (`BUILTIN_PROWLARR_SEARCH_TIMEOUT`), raced against the preset's 15s. The slowest indexer (a cold CF solve: 10-60s) gates the whole call → first request for a fresh title can lose ALL Prowlarr results; the express handler keeps running and the 1-week search cache makes the *second* request succeed. One verifier called this intended cache-warming architecture (stock defaults are tighter still); the other confirmed the mechanism end-to-end. Either way the family-visible behavior — "fresh titles may need a second open" — is real and the plan's Task 11 Step 1 expectation ("results appear within the timeout") will intermittently fail.
**Fix (cheap, coherent):** add the first-hit-miss note to Task 11; in Prowlarr, bound CF-gated indexer query timeouts so the aggregated call tends to fit 15s; optionally raise the preset timeout toward 30000 (max 50000) accepting worst-case latency. Combined with 4.3 this defines clean roles: kevbox = live search, MF = index lookup.

### 5.2 Memory limits on burst-prone containers (DISPUTED + UNVERIFIED — adopt as cheap insurance)
Spec §7 names RAM the top risk, yet none of the 8 new services (nor kevbox) carries `mem_limit`; firecrawl-api's 8 GiB cap alone can legally consume ~90% of the host; zilean's dmm-sync has documented ~1.9 GiB RSS spikes; FlareSolverr spawns a Chromium per concurrent solve. One refuter argued the importer would be the OOM victim anyway and imports resume — true, which is exactly why caps are safe: they convert host-wide OOM roulette into a contained restart.
**Fix:** `mem_limit` zilean 2g, zilean-postgres 1.5g, mediafusion-worker 1.5g, mediafusion 1g, flaresolverr 1g; `oom_score_adj: -500` on kevbox so the family service dies last; add `docker stats --no-stream && free -h` (firecrawl baseline) to Task 5 Step 2's pre-flight.

### 5.3 Silent worker death is invisible (UNVERIFIED — medium)
mediafusion-worker is the only long-running new service with no healthcheck and nothing depending on it; Docker takes no action on `unhealthy` anyway; all monitoring is "optional" Task 11 Step 3 and only HTTP-level — a wedged worker serves progressively staler results and nobody notices.
**Fix:** make Step 3 non-optional; add a `pgrep`-style healthcheck to the worker; monitor cron-job staleness (e.g. `MAX(last_enqueued_at)` age) or enable MF's Prometheus metrics.

### 5.4 No disk pre-flight (UNVERIFIED — low)
First `df` appears in Task 11 Step 5, *after* ~15-25 GB of imports into `/var/lib/docker`. Add `df -h /var/lib/docker` with a go/no-go threshold (≥40 GB) to Task 5 Step 2 and again before Task 9.

### 5.5 Boot-once preconfigured-indexer fetch, no retry (CONFIRMED — low)
After a VPS reboot, compose starts everything concurrently; kevbox's one-shot 5s fetch (`server.ts:125-131`, `addon.ts:63-70`) typically beats Prowlarr's startup → `preconfiguredIndexers` stays unset for the process lifetime. Streaming still works (live per-request fallback), but the configure-UI degrades and the proof line never appears.
**Fix:** ops note in KEVBOX.md ("after host reboot, restart kevbox once Prowlarr is healthy"), or relax Task 1's "leave kevbox unchanged" to add `depends_on: prowlarr: condition: service_started`.

---

## 6. One-liners / hygiene

| Item | Status | Action |
|---|---|---|
| `.env` perms | disputed (predecessor plan already `chmod 600`'d it) | add `stat -c %a .env` → expect `600` to Task 5 pre-flight (verify, don't assume) |
| certbot renewal | disputed → low | add `sudo certbot renew --dry-run` + timer check to Task 8; enable cert-expiry alert on the uptime-kuma HTTPS monitor |
| `:latest` on prowlarr/flaresolverr | disputed → low | upstream-recommended for both; compose doesn't auto-pull. Optional: pin anyway for consistency |
| redis no password | disputed → accept | standard single-tenant compose trust model; document the boundary (one line) |
| secrets sprawl into kevbox env | confirmed, low | compose interpolation reads project `.env` regardless of `env_file` — split a `kevbox.env` (4 BUILTIN_*/KEVBOX_* vars + existing) from interpolation-only secrets |
| spec wording: ":latest = old Python line" | confirmed, low | false — `:latest` == `6.0.0-beta.7` (stale v6 Rust beta). Pin rationale unchanged; fix the sentence |
| FlareSolverr RAM estimate | disputed → doc tweak | annotate §7: ~0.3 idle, ~0.5 GiB per concurrent CF solve; keep cf-tagged indexer count small |

---

## 7. Refuted (checked and cleared)

- **"Cutover pull-before-build breaks the running family service"** — refuted empirically: the single-file bind mount pins the old inode through `git pull`, so the old container serves the old template until the recreate. (The same mechanism is why §2.3's rollback note is wrong in the other direction.)
- **"Spec mislabels MF as public-unauthenticated"** — the spec only requires *public reachability* and documents the password gate; no contradiction.

---

## Suggested execution order for the fixes

1. Resolve §0 (internal-vs-public MF) — it deletes or commits §3 and part of Task 8.
2. Fold §1 into the Phase A commits (test env var, compose tweaks: shm_size, start_period, pg_stat_statements, optional mem_limits from §5.2).
3. Fold §2 + §4 + §5 edits into the plan text before starting Phase B (they're step rewrites, not code).
4. Re-run the audit's unverified items (§0, §4, parts of §5) against upstream once API budget allows: resume workflow `wf_c0749611-c32` — completed agents are cached; only the dead verifiers + completeness critic run.
