#!/usr/bin/env bash
# Prowlarr latency diagnostic: aggregated search time + per-indexer timing.
set -uo pipefail
cd /opt/kevbox/AIOStreams
K=$(grep '^PROWLARR_API_KEY=' .env | cut -d= -f2)
B=http://127.0.0.1:9696
Q="${1:-Euphoria}"

echo "=== aggregated search ALL indexers (query=$Q) ==="
t0=$(date +%s.%N)
n=$(curl -s -G -m 60 -H "X-Api-Key: $K" --data-urlencode "query=$Q" --data "type=search&limit=100" "$B/api/v1/search" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null)
t1=$(date +%s.%N)
echo "results=$n  time=$(echo "$t1-$t0" | bc)s"

echo
echo "=== per-indexer timing (only ENABLED indexers) ==="
ids=$(curl -s -H "X-Api-Key: $K" "$B/api/v1/indexer" | python3 -c "import sys,json;[print(i['id'],i.get('definitionName')) for i in json.load(sys.stdin) if i.get('enable')]")
while read -r id name; do
  [ -z "$id" ] && continue
  t0=$(date +%s.%N)
  cnt=$(curl -s -G -m 70 -H "X-Api-Key: $K" --data-urlencode "query=$Q" --data "type=search&limit=50&indexerIds=$id" "$B/api/v1/search" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo "ERR")
  t1=$(date +%s.%N)
  printf "  %-18s id=%-3s results=%-4s time=%ss\n" "$name" "$id" "$cnt" "$(echo "$t1-$t0" | bc)"
done <<< "$ids"
