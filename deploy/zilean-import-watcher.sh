#!/usr/bin/env bash
# Self-completing watcher for Zilean's first DMM import. When the import is
# genuinely done, it flips kevbox onto the local Zilean (Task 7 Step 3) and
# triggers the MediaFusion IMDb dataset import (Task 9 Step 4) — both safe,
# no-secret steps. Until then kevbox keeps using the PUBLIC Zilean (no gap).
#
# Completion = ALL of:
#   - the dmm-sync scraper subprocess is NOT running (initial backfill finished)
#   - an imdbid torznab query (the exact path AIOStreams uses) returns >0 items
#   - the "Torrents" row count is substantial AND stable across two polls
#   - at least MIN_ELAPSED_MIN minutes have passed since the watcher started
# Bounded by MAX_HOURS; on timeout it logs and exits WITHOUT flipping.
#
# Usage: zilean-import-watcher.sh [--check]   (--check prints state and exits)
set -uo pipefail
cd /opt/kevbox/AIOStreams

LOG=/opt/kevbox/zilean-cutover.log
COMPOSE="docker compose -f compose.kevbox.yaml"
MIN_ROWS=100000
MIN_ELAPSED_MIN=40
POLL_SECS=600
MAX_HOURS=12

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

scraper_running() {           # >0 means the dmm-sync scraper is still working
  docker exec zilean sh -c 'pgrep -fc "/app/scraper" 2>/dev/null || echo 0' 2>/dev/null | tr -d '[:space:]'
}
imdbid_items() {              # items returned by the imdbid path AIOStreams uses
  curl -s --max-time 20 "http://127.0.0.1:8181/torznab/api?t=movie&imdbid=tt0133093" 2>/dev/null | grep -c "<item>"
}
torrent_rows() {
  docker exec zilean-postgres psql -U postgres -d zilean -tAc 'SELECT count(*) FROM "Torrents";' 2>/dev/null | tr -d '[:space:]'
}

print_state() {
  echo "scraper_procs=$(scraper_running) imdbid_items=$(imdbid_items) torrent_rows=$(torrent_rows)"
}

if [ "${1:-}" = "--check" ]; then print_state; exit 0; fi

flip_and_import() {
  log "COMPLETE — flipping kevbox onto local Zilean"
  if ! grep -q '^BUILTIN_ZILEAN_URL=' .env; then
    echo "BUILTIN_ZILEAN_URL=http://zilean:8181" >> .env
    log "added BUILTIN_ZILEAN_URL=http://zilean:8181 to .env"
  fi
  $COMPOSE up -d --force-recreate kevbox >>"$LOG" 2>&1
  log "kevbox recreated (now using local Zilean)"
  log "DONE. Operator: only the real Premiumize playback test remains."
}

log "watcher started (pid $$); will flip when Zilean's first import completes"
start=$(date +%s); prev_rows=-1; stable_ready=0
STABLE_POLLS=2   # readiness must hold this many consecutive polls before flipping
while true; do
  now=$(date +%s); elapsed_min=$(( (now - start) / 60 ))
  sp=$(scraper_running); items=$(imdbid_items); rows=$(torrent_rows)
  rows=${rows:-0}; items=${items:-0}; sp=${sp:-1}
  # "ready this poll" = scraper idle, imdbid path works, substantial rows, no growth vs last poll
  if [ "$elapsed_min" -ge "$MIN_ELAPSED_MIN" ] && [ "$sp" = "0" ] && [ "$items" -gt 0 ] \
     && [ "$rows" -ge "$MIN_ROWS" ] && [ "$rows" = "$prev_rows" ]; then
    stable_ready=$(( stable_ready + 1 ))
  else
    stable_ready=0
  fi
  log "poll: scraper_procs=$sp imdbid_items=$items torrent_rows=$rows elapsed_min=$elapsed_min stable_ready=$stable_ready/$STABLE_POLLS"
  if [ "$stable_ready" -ge "$STABLE_POLLS" ]; then
    flip_and_import
    exit 0
  fi
  if [ "$elapsed_min" -ge $(( MAX_HOURS * 60 )) ]; then
    log "TIMEOUT after ${MAX_HOURS}h without a clean completion signal (scraper=$sp items=$items rows=$rows). NOT flipping — manual review: see plan Task 7 Step 3 + Task 9 Step 4."
    exit 1
  fi
  prev_rows=$rows
  sleep "$POLL_SECS"
done
