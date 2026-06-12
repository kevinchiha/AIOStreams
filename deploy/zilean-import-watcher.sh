#!/usr/bin/env bash
# Zilean readiness watcher for Kevbox/AIOStreams.
#
# What changed from the first watcher:
#   - Zilean's ImportMetadata is the source of truth. DmmLastImport.Status must
#     be Complete (1) before the watcher considers local Zilean ready.
#   - /app/scraper process absence is diagnostic only, not a completion gate.
#   - No fixed 12h timeout: the first import can run much longer than that.
#   - Row-count and latest-ingest stability must hold for a longer window.
#   - Coverage comparison against public Zilean is required before flipping.
#   - Default mode is report-only. Use --flip or AUTO_FLIP=1 to recreate kevbox.
#
# Usage:
#   zilean-import-watcher.sh --check       # print current state, no state update
#   zilean-import-watcher.sh --coverage    # run the public-vs-local sample test
#   zilean-import-watcher.sh --once        # one readiness poll, report-only
#   zilean-import-watcher.sh               # loop forever, report-only
#   zilean-import-watcher.sh --flip        # loop and flip kevbox when all gates pass
set -uo pipefail
cd /opt/kevbox/AIOStreams || exit 2

LOG=${LOG:-/opt/kevbox/zilean-cutover.log}
STATE_FILE=${STATE_FILE:-/opt/kevbox/zilean-import-watcher.state}
COMPOSE=${COMPOSE:-"docker compose -f compose.kevbox.yaml"}
LOCAL_ZILEAN_URL=${LOCAL_ZILEAN_URL:-http://127.0.0.1:8181}
PUBLIC_ZILEAN_URL=${PUBLIC_ZILEAN_URL:-https://zileanfortheweebs.midnightignite.me}
KEVBOX_ZILEAN_URL=${KEVBOX_ZILEAN_URL:-http://zilean:8181}

MIN_ROWS=${MIN_ROWS:-800000}
POLL_SECS=${POLL_SECS:-600}
STABLE_POLLS_REQUIRED=${STABLE_POLLS_REQUIRED:-12}   # 12 * 10m = 2h by default
COVERAGE_MIN_RATIO=${COVERAGE_MIN_RATIO:-0.85}
AUTO_FLIP=${AUTO_FLIP:-0}

log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

psql_scalar() {
  docker exec zilean-postgres psql -U postgres -d zilean -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

scraper_running() {
  docker exec zilean sh -c 'pgrep -fc "/app/scraper" 2>/dev/null || echo 0' 2>/dev/null | tr -d '[:space:]'
}

imdbid_items() {
  python3 - <<'PY' 2>/dev/null
from urllib.request import Request, urlopen
try:
    req = Request('http://127.0.0.1:8181/torznab/api?t=movie&imdbid=tt0133093', headers={'User-Agent':'zilean-watcher/2'})
    with urlopen(req, timeout=20) as r:
        print(r.read(250000).decode('utf-8', 'replace').count('<item>'))
except Exception:
    print(0)
PY
}

read_zilean_state() {
  docker exec zilean-postgres psql -U postgres -d zilean -tA -F '|' -c \
    "WITH dmm AS (
       SELECT \"Value\"::json AS v FROM \"ImportMetadata\" WHERE \"Key\"='DmmLastImport'
     ), stats AS (
       SELECT count(*)::bigint rows,
              coalesce(extract(epoch from max(\"IngestedAt\"))::bigint,0) latest_epoch,
              coalesce(max(\"IngestedAt\")::text,'') latest_ingested,
              count(*) FILTER (WHERE \"IngestedAt\" > now() - interval '30 minutes')::bigint last_30m,
              count(*) FILTER (WHERE \"IngestedAt\" > now() - interval '2 hours')::bigint last_2h
       FROM \"Torrents\"
     )
     SELECT coalesce((SELECT v->>'Status' FROM dmm),'missing'),
            coalesce((SELECT v->>'PageCount' FROM dmm),'0'),
            coalesce((SELECT v->>'EntryCount' FROM dmm),'0'),
            rows, latest_epoch, latest_ingested, last_30m, last_2h
     FROM stats;" 2>/dev/null
}

status_name() {
  case "$1" in
    0) echo InProgress ;;
    1) echo Complete ;;
    2) echo Failed ;;
    missing) echo Missing ;;
    *) echo Unknown ;;
  esac
}

print_state() {
  local raw status pages entries rows latest_epoch latest_ingested last_30m last_2h sp items
  raw=$(read_zilean_state)
  IFS='|' read -r status pages entries rows latest_epoch latest_ingested last_30m last_2h <<<"$raw"
  sp=$(scraper_running); items=$(imdbid_items)
  echo "dmm_status=$status ($(status_name "$status")) dmm_pages=$pages dmm_entries=$entries torrent_rows=$rows latest_ingested=$latest_ingested last_30m=$last_30m last_2h=$last_2h scraper_procs=$sp imdbid_items=$items"
}

coverage_check() {
  PUBLIC_ZILEAN_URL="$PUBLIC_ZILEAN_URL" LOCAL_ZILEAN_URL="$LOCAL_ZILEAN_URL" COVERAGE_MIN_RATIO="$COVERAGE_MIN_RATIO" python3 - <<'PY'
from urllib.request import Request, urlopen
from urllib.parse import urlencode
import os, re, sys, time
public=os.environ['PUBLIC_ZILEAN_URL'].rstrip('/')
local=os.environ['LOCAL_ZILEAN_URL'].rstrip('/')
threshold=float(os.environ.get('COVERAGE_MIN_RATIO','0.85'))
titles=[
 ('The Matrix','movie','tt0133093'), ('Inception','movie','tt1375666'),
 ('Avatar','movie','tt0499549'), ('Breaking Bad','tvsearch','tt0903747'),
 ('Game of Thrones','tvsearch','tt0944947'), ('Dune Part Two','movie','tt15239678'),
 ('Oppenheimer','movie','tt15398776'), ('Barbie','movie','tt1517268'),
 ('Fallout','tvsearch','tt12637874'), ('Shogun','tvsearch','tt2788316'),
 ('Casablanca','movie','tt0034583'), ('The Wizard of Oz','movie','tt0032138'),
 ('Psycho','movie','tt0054215'), ('Star Trek TOS','tvsearch','tt0060028'),
 ('I Love Lucy','tvsearch','tt0043208'), ('Primer','movie','tt0390384'),
 ('Coherence','movie','tt2866360'), ('The Vast of Night','movie','tt6803046'),
 ('Patriot','tvsearch','tt4687882'), ('Detectorists','tvsearch','tt4082744'),
]
def count(base, mode, imdbid):
    url=base + '/torznab/api?' + urlencode({'t':mode,'imdbid':imdbid,'limit':'100'})
    req=Request(url, headers={'User-Agent':'zilean-watcher/2'})
    with urlopen(req, timeout=25) as r:
        return r.read(300000).decode('utf-8','replace').count('<item>')
fail=[]; rows=[]
for title,mode,imdbid in titles:
    try:
        p=count(public,mode,imdbid); l=count(local,mode,imdbid)
    except Exception as e:
        print(f'COVERAGE_ERROR title={title!r} error={type(e).__name__}:{str(e)[:120]}')
        sys.exit(2)
    ratio = 1.0 if p == 0 else (l / p)
    rows.append((title,p,l,ratio))
    if p > 0 and ratio < threshold:
        fail.append((title,p,l,ratio))
    time.sleep(0.1)
for title,p,l,ratio in rows:
    print(f'COVERAGE title={title!r} public={p} local={l} ratio={ratio:.2f}')
print(f'COVERAGE_SUMMARY pass={0 if fail else 1} failures={len(fail)} threshold={threshold:.2f}')
if fail:
    print('COVERAGE_FAILURES ' + '; '.join(f'{t}: public={p} local={l} ratio={r:.2f}' for t,p,l,r in fail[:10]))
    sys.exit(1)
PY
}

flip_and_import() {
  log "COMPLETE — flipping kevbox onto local Zilean ($KEVBOX_ZILEAN_URL)"
  if grep -q '^BUILTIN_ZILEAN_URL=' .env; then
    python3 - <<PY
from pathlib import Path
p=Path('.env')
s=p.read_text()
lines=[]
for line in s.splitlines():
    if line.startswith('BUILTIN_ZILEAN_URL='):
        lines.append('BUILTIN_ZILEAN_URL=$KEVBOX_ZILEAN_URL')
    else:
        lines.append(line)
p.write_text('\n'.join(lines)+'\n')
PY
    log "updated BUILTIN_ZILEAN_URL=$KEVBOX_ZILEAN_URL in .env"
  else
    printf '\nBUILTIN_ZILEAN_URL=%s\n' "$KEVBOX_ZILEAN_URL" >> .env
    log "added BUILTIN_ZILEAN_URL=$KEVBOX_ZILEAN_URL to .env"
  fi
  $COMPOSE up -d --force-recreate kevbox >>"$LOG" 2>&1
  log "kevbox recreated (now using local Zilean). Operator: run real Premiumize playback test."
}

mode=loop
case "${1:-}" in
  --check) print_state; exit 0 ;;
  --coverage) coverage_check; exit $? ;;
  --once) mode=once ;;
  --flip) AUTO_FLIP=1; mode=loop ;;
  "") mode=loop ;;
  *) echo "Usage: $0 [--check|--coverage|--once|--flip]" >&2; exit 2 ;;
esac

log "watcher started (pid $$); mode=$mode auto_flip=$AUTO_FLIP min_rows=$MIN_ROWS stable_polls=$STABLE_POLLS_REQUIRED coverage_ratio=$COVERAGE_MIN_RATIO"

while true; do
  raw=$(read_zilean_state)
  IFS='|' read -r status pages entries rows latest_epoch latest_ingested last_30m last_2h <<<"$raw"
  sp=$(scraper_running); items=$(imdbid_items)
  rows=${rows:-0}; latest_epoch=${latest_epoch:-0}; items=${items:-0}; sp=${sp:-0}; status=${status:-missing}

  prev_rows=-1; prev_latest=-1; stable_ready=0
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE" 2>/dev/null || true
  fi

  if [ "$status" = "2" ]; then
    log "FAILED — Zilean DmmLastImport.Status=Failed. rows=$rows latest=$latest_ingested. NOT flipping."
    exit 1
  fi

  if [ "$status" = "1" ] && [ "$rows" -ge "$MIN_ROWS" ] && [ "$items" -gt 0 ] \
     && [ "$rows" = "$prev_rows" ] && [ "$latest_epoch" = "$prev_latest" ]; then
    stable_ready=$(( stable_ready + 1 ))
  else
    stable_ready=0
  fi

  {
    echo "prev_rows=$rows"
    echo "prev_latest=$latest_epoch"
    echo "stable_ready=$stable_ready"
  } > "$STATE_FILE"

  log "poll: dmm_status=$status($(status_name "$status")) pages=$pages entries=$entries rows=$rows latest='$latest_ingested' last_30m=$last_30m last_2h=$last_2h scraper_procs=$sp imdbid_items=$items stable_ready=$stable_ready/$STABLE_POLLS_REQUIRED"

  if [ "$stable_ready" -ge "$STABLE_POLLS_REQUIRED" ]; then
    log "base readiness passed; running public-vs-local coverage gate"
    if coverage_check >>"$LOG" 2>&1; then
      if [ "$AUTO_FLIP" = "1" ]; then
        flip_and_import
      else
        log "READY — local Zilean passed all gates. Report-only mode: NOT flipping. Re-run with --flip or AUTO_FLIP=1 to switch Kevbox."
      fi
      exit 0
    else
      log "NOT READY — coverage gate failed. Keeping Kevbox on public Zilean."
      stable_ready=0
      {
        echo "prev_rows=$rows"
        echo "prev_latest=$latest_epoch"
        echo "stable_ready=0"
      } > "$STATE_FILE"
    fi
  fi

  [ "$mode" = "once" ] && exit 0
  sleep "$POLL_SECS"
done
