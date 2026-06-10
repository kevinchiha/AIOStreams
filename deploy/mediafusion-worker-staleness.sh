#!/usr/bin/env bash
# Watchdog for mediafusion-worker, which runs every MF cron/queue job but exposes
# NO health surface — if it wedges, the API keeps serving progressively staler
# results behind a green /health. We probe cron_jobs.last_enqueued_at: if nothing
# has been enqueued for > 6h, the worker is presumed wedged.
#
# Installed as a host cron (every 30 min). Writes status to a state file and logs
# a warning to syslog on staleness. If an uptime-kuma PUSH monitor URL is provided
# via KUMA_PUSH_URL (env or below), it pings it ONLY on success — a missed ping is
# the alert.
set -euo pipefail

STATE_FILE=/opt/kevbox/mediafusion-worker.status
KUMA_PUSH_URL="${KUMA_PUSH_URL:-}"   # optional: set to an uptime-kuma push monitor URL

ts=$(date -Is)

# Check 1: the worker container must be running (a crashed worker is the loud failure).
running=$(docker inspect -f '{{.State.Running}}' mediafusion-worker 2>/dev/null || echo "missing")
if [ "$running" != "true" ]; then
  echo "$ts DOWN mediafusion-worker not running (state=$running)" > "$STATE_FILE"
  logger -t kevbox-mediafusion-worker "DOWN: mediafusion-worker container is not running (state=$running)"
  exit 1
fi

# Check 2: staleness of the scheduler's enqueue clock. NULL = warming (no job has had
# work yet on a low-traffic box) → treat as OK, never alarm. Only a non-NULL clock
# older than 6h means a worker that WAS enqueuing has wedged (the real failure mode:
# API keeps serving staler results behind a green /health).
state=$(docker exec mediafusion-postgres psql -U mediafusion -d mediafusion -tAc \
  "SELECT CASE
            WHEN max(last_enqueued_at) IS NULL THEN 'warming'
            WHEN (now() - max(last_enqueued_at)) < interval '6 hours' THEN 'fresh'
            ELSE 'stale'
          END
   FROM cron_jobs WHERE enabled;" 2>/dev/null | tr -d '[:space:]' || echo "error")

if [ "$state" = "stale" ]; then
  echo "$ts STALE worker last_enqueued > 6h" > "$STATE_FILE"
  logger -t kevbox-mediafusion-worker "STALE: mediafusion-worker last enqueued a job > 6h ago — investigate (docker logs mediafusion-worker)"
  exit 1
fi

# fresh / warming / (error tolerated as transient) → OK
echo "$ts OK worker $state" > "$STATE_FILE"
[ -n "$KUMA_PUSH_URL" ] && curl -fsS -m 10 "$KUMA_PUSH_URL?status=up&msg=worker-$state" >/dev/null 2>&1 || true
exit 0
