#!/usr/bin/env python3
"""Add the curated Kevbox indexer set to Prowlarr via API (idempotent).

Reads PROWLARR_API_KEY from the .env in the cwd. Adds each target indexer from
the schema, tagging Cloudflare-protected ones with `cf` so the FlareSolverr
proxy applies. Tests each and prints a status table. Re-runnable: skips
indexers already present by definitionName.
"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:9696"


def env_key():
    with open(".env") as fh:
        for line in fh:
            if line.startswith("PROWLARR_API_KEY="):
                return line.strip().split("=", 1)[1]
    sys.exit("PROWLARR_API_KEY not in .env")


KEY = env_key()


def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"X-Api-Key": KEY, "Content-Type": "application/json"},
    )
    try:
        raw = urllib.request.urlopen(r, timeout=120).read()
        return json.loads(raw or "null")
    except urllib.error.HTTPError as e:
        return {"__error__": e.code, "__body__": e.read().decode()[:400]}


# (label, [match keywords on definitionName/name], cf?)
TARGETS = [
    ("1337x",            ["1337x"],            True),
    ("The Pirate Bay",   ["thepiratebay"],     False),
    ("YTS",              ["yts"],              False),
    ("EZTV",             ["eztv"],             False),
    ("LimeTorrents",     ["limetorrents"],     False),
    ("Nyaa.si",          ["nyaasi"],           False),
    ("BitSearch",        ["bitsearch"],        False),
    ("Torlock",          ["torlock"],          False),
    ("TorrentDownload",  ["torrentdownload"],  False),
    ("RuTor",            ["rutor"],            False),
    ("Knaben",           ["knaben"],           False),
    ("TorrentGalaxy",    ["torrentgalaxyclone", "torrentgalaxy"], True),
]


def best_match(schema, keywords):
    cands = []
    for s in schema:
        dn = (s.get("definitionName") or "").lower()
        nm = (s.get("name") or "").lower()
        for kw in keywords:
            if dn == kw:
                cands.append((0, len(dn), s)); break
            if kw in dn or kw in nm:
                cands.append((1, len(dn), s)); break
    # prefer public privacy, then exact/short definitionName
    cands.sort(key=lambda c: (c[0], 0 if c[2].get("privacy") == "public" else 1, c[1]))
    return cands[0][2] if cands else None


def main():
    schema = req("GET", "/api/v1/indexer/schema")
    if isinstance(schema, dict):
        sys.exit("schema fetch failed: %s" % schema)
    tags = req("GET", "/api/v1/tag")
    cf_id = next((t["id"] for t in tags if t["label"] == "cf"), None)
    existing = {(i.get("definitionName") or i["name"]).lower(): i
                for i in req("GET", "/api/v1/indexer")}

    results = []
    for label, keywords, cf in TARGETS:
        s = best_match(schema, keywords)
        if not s:
            results.append((label, "NO-SCHEMA", "-"))
            continue
        dn = (s.get("definitionName") or s["name"]).lower()
        if dn in existing:
            results.append((label, "exists", s.get("definitionName")))
            continue
        body = dict(s)
        body["enable"] = True
        body["appProfileId"] = 1
        body["tags"] = [cf_id] if (cf and cf_id) else []
        created = req("POST", "/api/v1/indexer?forceSave=true", body)
        if isinstance(created, dict) and "__error__" in created:
            results.append((label, "ERR %s" % created["__error__"], created["__body__"][:120]))
        else:
            results.append((label, "added", "%s%s" % (s.get("definitionName"), " +cf" if (cf and cf_id) else "")))

    print("\n=== indexer add results ===")
    for label, status, detail in results:
        print("  %-18s %-10s %s" % (label, status, detail))

    print("\n=== testing all indexers (testall) ===")
    test = req("POST", "/api/v1/indexer/testall", None)
    if isinstance(test, list):
        for t in test:
            print("  id=%s ok=%s" % (t.get("id"), t.get("isValid")))
    else:
        print("  testall response:", json.dumps(test)[:300])

    final = req("GET", "/api/v1/indexer")
    print("\ntotal indexers now: %d" % (len(final) if isinstance(final, list) else -1))


if __name__ == "__main__":
    main()
