# Kevbox Self-Hosted Sourcing Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-host the sourcing layer (Prowlarr + FlareSolverr, Zilean, MediaFusion) on the VPS, wire it into Kevbox via existing builtins/env vars, and retire the flaky external scrapers (Comet, Sootio, Knaben, TorrentGalaxy builtins).

**Architecture:** All new services join the existing `compose.kevbox.yaml` project (shared network, pinned subnet `172.30.0.0/16`, DNS by service name). Kevbox reaches Prowlarr via the AIOStreams Prowlarr builtin in preconfigured-instance mode (`BUILTIN_PROWLARR_URL`/`BUILTIN_PROWLARR_API_KEY` env), Zilean via `BUILTIN_ZILEAN_URL` (Torznab builtin), and self-hosted MediaFusion via a `${KEVBOX_MEDIAFUSION_URL}` template placeholder pointing at a new public vhost `mf.kevbox.dev` (MediaFusion playback URLs route through its `HOST_URL`, so family Stremio clients must reach it). Spec: [`docs/superpowers/specs/2026-06-10-kevbox-sourcing-stack.md`](../specs/2026-06-10-kevbox-sourcing-stack.md).

**Tech Stack:** docker compose; `lscr.io/linuxserver/prowlarr`, `ghcr.io/flaresolverr/flaresolverr`, `ipromknight/zilean:v3.5.0` + `postgres:17-alpine`, `mhdzumair/mediafusion:6.0.0-beta.21` (Rust; **never `:latest`** — that's the old Python line) + `postgres:18-alpine` + `redis:7-alpine`; nginx + certbot on the host; vitest for the template tests.

**Execution split:** Phase A (Tasks 1–3) is **local repo work** on this machine — TDD, commits. Phase B (Tasks 4–11) is **VPS ops** over SSH (`ssh persovps` — adjust to your actual SSH alias). Commit order in Phase A is load-bearing: the template on the VPS is bind-mounted with instant mtime reload, so the VPS merges only the infra commit (Task 1) at first, and takes the template commit (Task 2) at cutover (Task 10) after all env vars and services exist.

**Secrets policy:** the fork is PUBLIC. No secret values in any committed file — secrets go only into the VPS `.env`. The template references env via `${VAR}` placeholders; compose references env via `${VAR}` interpolation from the same `.env`.

---

## Phase A — Local repo changes

### Task 1: Compose infrastructure (the "infra commit")

**Files:**
- Modify: `compose.kevbox.yaml`
- Create: `deploy/mediafusion-postgres-init.sql`

- [ ] **Step 1: Create the MediaFusion Postgres init script**

Create `deploy/mediafusion-postgres-init.sql` (MediaFusion's official deployment creates these extensions for full-text search; we skip its replication setup):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
```

- [ ] **Step 2: Append the new services to `compose.kevbox.yaml`**

The current file has a single `kevbox` service and a `networks` block. Leave both **unchanged**. Add an `x-mediafusion-env` anchor at the very top of the file (before `services:`), add the new services inside `services:`, and add a top-level `volumes:` block at the end (before `networks:`). Final file = existing content + these additions:

```yaml
# Shared env for the MediaFusion api + worker (same image, two commands).
# Sources: our own Prowlarr + Zilean only. Public-site live scrapers are OFF
# (Cloudflare sites are covered via Prowlarr+FlareSolverr instead), which is
# also why the official stack's browserless/byparr containers are absent here.
x-mediafusion-env: &mediafusion-env
  HOST_URL: ${KEVBOX_MEDIAFUSION_URL}
  POSTER_HOST_URL: ${KEVBOX_MEDIAFUSION_URL}
  CONTACT_EMAIL: kevin.chiha@gmail.com
  SECRET_KEY: ${MEDIAFUSION_SECRET_KEY}
  API_PASSWORD: ${MEDIAFUSION_API_PASSWORD}
  POSTGRES_URI: postgresql://mediafusion:${MEDIAFUSION_POSTGRES_PASSWORD}@mediafusion-postgres:5432/mediafusion
  REDIS_URL: redis://mediafusion-redis:6379
  IS_SCRAP_FROM_PROWLARR: "true"
  PROWLARR_URL: http://prowlarr:9696
  PROWLARR_API_KEY: ${PROWLARR_API_KEY}
  PROWLARR_LIVE_TITLE_SEARCH: "true"
  IS_SCRAP_FROM_PUBLIC_INDEXERS: "false"
  IS_SCRAP_FROM_PUBLIC_USENET_INDEXERS: "false"
  IS_SCRAP_FROM_TORRENTIO: "false"
  IS_SCRAP_FROM_MEDIAFUSION: "false"
  IS_SCRAP_FROM_ZILEAN: "true"
  ZILEAN_URL: http://zilean:8181
  ENABLE_RATE_LIMIT: "false"
```

New services (append inside `services:`, sibling to `kevbox`):

```yaml
  prowlarr:
    image: lscr.io/linuxserver/prowlarr:latest
    container_name: prowlarr
    restart: unless-stopped
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
    volumes:
      - prowlarr-config:/config
    ports:
      - 127.0.0.1:9696:9696   # UI/API via SSH tunnel only; kevbox + mediafusion use http://prowlarr:9696
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    restart: unless-stopped
    environment:
      - LOG_LEVEL=info
    # No host port: only Prowlarr consumes it, at http://flaresolverr:8191
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

  zilean:
    image: ipromknight/zilean:v3.5.0
    container_name: zilean
    restart: unless-stopped
    tty: true
    environment:
      Zilean__Database__ConnectionString: "Host=zilean-postgres;Port=5432;Database=zilean;Username=postgres;Password=${ZILEAN_POSTGRES_PASSWORD};Include Error Detail=true;Timeout=30;CommandTimeout=3600;"
      Zilean__Dmm__EnableScraping: "true"
      Zilean__Torznab__EnableEndpoint: "true"      # AIOStreams' zilean preset consumes <url>/torznab/api
      Zilean__Imdb__EnableImportMatching: "true"   # required: AIOStreams prefers imdbid= torznab searches
      Zilean__Imdb__UseLucene: "false"             # true would cost ~3 GB extra RAM during resyncs
      Zilean__Imdb__UseAllCores: "false"
      Zilean__Imdb__NumberOfCores: "2"
      Zilean__EnableDashboard: "false"
    volumes:
      - zilean-data:/app/data
      - zilean-tmp:/tmp
    ports:
      - 127.0.0.1:8181:8181   # ops/debug via SSH tunnel; kevbox + mediafusion use http://zilean:8181
    healthcheck:
      test: curl --connect-timeout 10 --silent --show-error --fail http://localhost:8181/healthchecks/ping
      timeout: 60s
      interval: 30s
      retries: 10
    depends_on:
      zilean-postgres:
        condition: service_healthy
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

  zilean-postgres:
    image: postgres:17-alpine
    container_name: zilean-postgres
    restart: unless-stopped
    shm_size: 1g
    environment:
      PGDATA: /var/lib/postgresql/data/pgdata
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${ZILEAN_POSTGRES_PASSWORD}
      POSTGRES_DB: zilean
    volumes:
      - zilean-postgres-data:/var/lib/postgresql/data/pgdata
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

  mediafusion:
    image: mhdzumair/mediafusion:6.0.0-beta.21
    container_name: mediafusion
    restart: unless-stopped
    environment: *mediafusion-env
    ports:
      - 127.0.0.1:8000:8000   # host nginx vhost mf.kevbox.dev proxies here
    depends_on:
      mediafusion-postgres:
        condition: service_healthy
      mediafusion-redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 1m
      timeout: 10s
      retries: 5
      start_period: 20m       # first boot runs sqlx migrations + IMDb dataset import
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

  mediafusion-worker:
    image: mhdzumair/mediafusion:6.0.0-beta.21
    container_name: mediafusion-worker
    command: ["/usr/local/bin/mediafusion-worker"]
    restart: unless-stopped
    environment: *mediafusion-env
    depends_on:
      mediafusion-postgres:
        condition: service_healthy
      mediafusion-redis:
        condition: service_healthy
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

  mediafusion-postgres:
    image: postgres:18-alpine
    container_name: mediafusion-postgres
    restart: unless-stopped
    shm_size: 256mb
    environment:
      POSTGRES_USER: mediafusion
      POSTGRES_PASSWORD: ${MEDIAFUSION_POSTGRES_PASSWORD}
      POSTGRES_DB: mediafusion
    command:
      - "postgres"
      - "-c"
      - "shared_buffers=256MB"
      - "-c"
      - "effective_cache_size=768MB"
      - "-c"
      - "maintenance_work_mem=64MB"
      - "-c"
      - "work_mem=8MB"
      - "-c"
      - "random_page_cost=1.1"
      - "-c"
      - "max_connections=100"
    volumes:
      - mediafusion-postgres-data:/var/lib/postgresql
      - ./deploy/mediafusion-postgres-init.sql:/docker-entrypoint-initdb.d/01-extensions.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mediafusion -d mediafusion"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'

  mediafusion-redis:
    image: redis:7-alpine
    container_name: mediafusion-redis
    restart: unless-stopped
    # No maxmemory/eviction policy: Redis is MediaFusion's task queue —
    # evicting queue keys under memory pressure would silently drop jobs.
    command: redis-server --appendonly yes --save 60 1
    volumes:
      - mediafusion-redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: '3'
```

Top-level volumes block (append after `services:`, before `networks:`):

```yaml
volumes:
  prowlarr-config:
  zilean-data:
  zilean-tmp:
  zilean-postgres-data:
  mediafusion-postgres-data:
  mediafusion-redis-data:
```

- [ ] **Step 3: Validate the compose file**

Run: `docker compose -f compose.kevbox.yaml config --quiet`
Expected: exit 0, only warnings about unset variables (e.g. `"ZILEAN_POSTGRES_PASSWORD" variable is not set`) — those are defined in the VPS `.env`.
(If docker isn't installed locally, skip — Task 5 Step 2 validates on the VPS before anything starts.)

- [ ] **Step 4: Commit and record the SHA**

```bash
git add compose.kevbox.yaml deploy/mediafusion-postgres-init.sql
git commit -m "feat(kevbox): add self-hosted sourcing services to compose (prowlarr, flaresolverr, zilean, mediafusion)"
git rev-parse --short HEAD   # ← record this: it is <INFRA_SHA>, used in Task 5
```

---

### Task 2: Template lineup change (TDD)

**Files:**
- Modify: `packages/server/src/utils/kevboxRepoTemplate.test.ts`
- Modify: `kevbox.config.json`

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `packages/server/src/utils/kevboxRepoTemplate.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKevboxTemplate, loadKevboxTemplate } from './kevboxTemplate.js';

// repo root relative to packages/server/src/utils/
const repoTemplate = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../kevbox.config.json'
);

const dummyEnv = {
  KEVBOX_MEDIAFLOW_URL: 'https://mediaflow.example.com',
  KEVBOX_MEDIAFLOW_PASSWORD: 'dummy-password',
  KEVBOX_RPDB_KEY: 'dummy-rpdb-key',
  KEVBOX_MEDIAFUSION_URL: 'https://mediafusion.example.com',
};

interface TemplatePreset {
  type: string;
  instanceId: string;
  enabled: boolean;
  options: Record<string, unknown> & { services?: string[] };
}

interface TemplateCatalogModification {
  addonName: string;
}

function presets(template: Record<string, unknown>): TemplatePreset[] {
  return template.presets as TemplatePreset[];
}

describe('repo kevbox.config.json', () => {
  it('passes the boot check with all placeholders substituted', () => {
    expect(checkKevboxTemplate(repoTemplate, dummyEnv)).toEqual({ ok: true });
  });

  it('has torrentio as the first preset, wired to premiumize', () => {
    const all = presets(loadKevboxTemplate(repoTemplate, dummyEnv));
    expect(all[0].type).toBe('torrentio');
    expect(all[0].enabled).toBe(true);
    expect(all[0].options.services).toEqual(['premiumize']);
  });

  it('contains no unsubstituted placeholders after load', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    expect(JSON.stringify(template)).not.toContain('${');
  });

  it('carries no stale export artifacts', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    expect(template.trusted).toBeUndefined();
    expect(JSON.stringify(template)).not.toContain('fankai');
  });

  it('has exactly the agreed sourcing lineup, all enabled on premiumize', () => {
    const all = presets(loadKevboxTemplate(repoTemplate, dummyEnv));
    expect(all.map((p) => p.type).sort()).toEqual(
      [
        'mediafusion',
        'peerflix',
        'prowlarr',
        'stremthruTorz',
        'torrentio',
        'torrents-db',
        'zilean',
      ].sort()
    );
    for (const preset of all) {
      expect(preset.enabled, `${preset.type} should be enabled`).toBe(true);
      expect(
        preset.options.services,
        `${preset.type} should use premiumize`
      ).toEqual(['premiumize']);
    }
  });

  it('prowlarr preset relies on the preconfigured builtin instance (no url/key in template)', () => {
    const prowlarr = presets(loadKevboxTemplate(repoTemplate, dummyEnv)).find(
      (p) => p.type === 'prowlarr'
    );
    expect(prowlarr).toBeDefined();
    expect(prowlarr?.options.prowlarrUrl).toBeUndefined();
    expect(prowlarr?.options.prowlarrApiKey).toBeUndefined();
    expect(prowlarr?.options.sources).toEqual(['torrent']);
  });

  it('mediafusion points at the self-hosted instance via env placeholder', () => {
    const mediafusion = presets(loadKevboxTemplate(repoTemplate, dummyEnv)).find(
      (p) => p.type === 'mediafusion'
    );
    expect(mediafusion?.options.url).toBe('https://mediafusion.example.com');
    expect(mediafusion?.options.useCachedResultsOnly).toBe(true);
  });

  it('carries no catalog modifications for dropped addons', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    const mods = template.catalogModifications as TemplateCatalogModification[];
    const addonNames = mods.map((m) => m.addonName);
    expect(addonNames).not.toContain('Sootio');
    expect(addonNames).not.toContain('Comet');
    expect(addonNames.sort()).toEqual(['Peerflix', 'TorrentsDB']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F server exec vitest run src/utils/kevboxRepoTemplate.test.ts`
Expected: FAIL — "has exactly the agreed sourcing lineup" reports `comet`, `sootio`, `knaben`, `torrent-galaxy` present and `prowlarr` missing; "carries no catalog modifications" reports `Sootio` entries; "mediafusion points at the self-hosted instance" reports `options.url` undefined.

- [ ] **Step 3: Edit `kevbox.config.json`**

Four edits, in the `presets` array and `catalogModifications`:

1. **Delete** these four whole preset objects: `"type": "comet"` (instanceId `782`), `"type": "sootio"` (`2c2`), `"type": "knaben"` (`7c4`), `"type": "torrent-galaxy"` (`7f3`).

2. **Replace** the `mediafusion` entry (instanceId `a04`) with (only change: the added `"url"` line):

```json
    {
      "type": "mediafusion",
      "instanceId": "a04",
      "enabled": true,
      "options": {
        "name": "MediaFusion",
        "timeout": 10000,
        "url": "${KEVBOX_MEDIAFUSION_URL}",
        "resources": [
          "stream",
          "catalog",
          "meta"
        ],
        "useCachedResultsOnly": true,
        "enableWatchlistCatalogs": false,
        "downloadViaBrowser": false,
        "contributorStreams": false,
        "certificationLevelsFilter": [],
        "nudityFilter": [],
        "services": [
          "premiumize"
        ]
      }
    },
```

3. **Append** the new prowlarr preset after the `peerflix` entry (last in the array). No URL/key — the builtin's preconfigured instance (`BUILTIN_PROWLARR_URL`/`BUILTIN_PROWLARR_API_KEY` on the VPS) supplies them; empty `indexers` = all indexers enabled in Prowlarr; timeout is higher than the index addons because Prowlarr does live indexer fan-out:

```json
    {
      "type": "prowlarr",
      "instanceId": "9b2",
      "enabled": true,
      "options": {
        "name": "Prowlarr",
        "timeout": 15000,
        "resources": ["stream"],
        "indexers": [],
        "sources": ["torrent"],
        "mediaTypes": [],
        "services": ["premiumize"],
        "useMultipleInstances": false
      }
    }
```

(Mind the commas: `peerflix` gets a trailing comma, the prowlarr object is last.)

4. **Replace** the whole `catalogModifications` array with (Sootio's two `premiumize-downloads` entries removed):

```json
  "catalogModifications": [
    {
      "id": "4ea6b98.peerflix-premiumize",
      "type": "other",
      "name": "Premiumize",
      "shuffle": false,
      "enabled": true,
      "hideable": true,
      "searchable": false,
      "addonName": "Peerflix"
    },
    {
      "id": "6ea6b98.torrentsdb-premiumize",
      "type": "other",
      "name": "Premiumize",
      "shuffle": false,
      "enabled": true,
      "hideable": true,
      "searchable": false,
      "addonName": "TorrentsDB"
    }
  ],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F server exec vitest run src/utils/kevboxRepoTemplate.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Run the full server test suite**

Run: `pnpm -F server test`
Expected: PASS (the other kevbox tests use fixtures, not the repo template, so they are unaffected).

- [ ] **Step 6: Commit**

```bash
git add kevbox.config.json packages/server/src/utils/kevboxRepoTemplate.test.ts
git commit -m "feat(kevbox): switch template to self-hosted sourcing lineup

Drop comet/sootio/knaben/torrent-galaxy, add prowlarr builtin preset,
repoint mediafusion at \${KEVBOX_MEDIAFUSION_URL}, prune sootio catalogs."
```

---

### Task 3: Document the new stack

**Files:**
- Modify: `KEVBOX.md`

- [ ] **Step 1: Extend the env-var table**

In `KEVBOX.md`, in "The template" section's env table, add after the `KEVBOX_TEMPLATE_PATH` row:

```markdown
| `KEVBOX_MEDIAFUSION_URL` | Base URL of the self-hosted MediaFusion (`https://mf.kevbox.dev`) — substituted into the template's `mediafusion` preset |
```

- [ ] **Step 2: Add a sourcing-stack section**

Add before the "VPS environment" section:

```markdown
## Self-hosted sourcing stack

The compose project also runs the sourcing layer (design + plan in
`docs/superpowers/specs/2026-06-10-kevbox-sourcing-stack.md` and
`docs/superpowers/plans/2026-06-10-kevbox-sourcing-stack.md`):

| Service | Role | Reached at |
| --- | --- | --- |
| `prowlarr` (+ `flaresolverr`) | Indexer manager (live torrent-site search, Cloudflare cleared by FlareSolverr) | Kevbox builtin via `BUILTIN_PROWLARR_URL` / `BUILTIN_PROWLARR_API_KEY`; UI via SSH tunnel to `127.0.0.1:9696` |
| `zilean` (+ `zilean-postgres`) | DMM cached-hash index (Torznab) | `BUILTIN_ZILEAN_URL=http://zilean:8181` |
| `mediafusion` api+worker (+ `mediafusion-postgres`, `mediafusion-redis`) | Self-hosted MediaFusion, scraping our Prowlarr + Zilean only | template `url` = `${KEVBOX_MEDIAFUSION_URL}` → public vhost `mf.kevbox.dev` (playback URLs route through it, so it must stay publicly reachable; its nginx vhost keeps `access_log off`) |

External fallbacks kept in the template: Torrentio, StremThru Torz, Peerflix,
TorrentsDB. Dropped: Comet, Sootio, and the in-process Knaben/TorrentGalaxy
builtins (now Prowlarr indexers).

Additional `.env` vars on the VPS (names only — values never in git):
`BUILTIN_PROWLARR_URL`, `BUILTIN_PROWLARR_API_KEY`, `PROWLARR_API_KEY` (same
value, consumed by MediaFusion/compose), `BUILTIN_ZILEAN_URL`,
`ZILEAN_POSTGRES_PASSWORD`, `KEVBOX_MEDIAFUSION_URL`, `MEDIAFUSION_SECRET_KEY`,
`MEDIAFUSION_API_PASSWORD`, `MEDIAFUSION_POSTGRES_PASSWORD`.
```

- [ ] **Step 3: Commit and push**

```bash
git add KEVBOX.md
git commit -m "docs(kevbox): document the self-hosted sourcing stack"
git push origin kevbox
```

---

## Phase B — VPS deployment (over SSH)

> Every task below runs on the VPS unless stated otherwise. The repo checkout
> lives at `/opt/kevbox/AIOStreams`, branch `kevbox`. Family service stays on
> the current lineup until Task 10 — nothing here disturbs it.

### Task 4: 4 GB swap file

- [ ] **Step 1: Confirm there is currently no swap**

Run: `free -h | grep -i swap`
Expected: `Swap: 0B 0B 0B`. If swap already exists, skip to Task 5.

- [ ] **Step 2: Create, enable, persist**

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl -p /etc/sysctl.d/99-swappiness.conf
```

- [ ] **Step 3: Verify**

Run: `free -h | grep -i swap && cat /proc/sys/vm/swappiness`
Expected: `Swap: 4.0Gi ...` and `10`.

### Task 5: Stage the infra commit + non-Prowlarr env vars

- [ ] **Step 1: Merge ONLY the infra commit**

`<INFRA_SHA>` is the SHA recorded in Task 1 Step 4. This brings the compose
changes WITHOUT the new template (the template is bind-mounted with instant
reload — it must not land until Task 10):

```bash
cd /opt/kevbox/AIOStreams
git fetch origin
git merge --ff-only <INFRA_SHA>
git log --oneline -1            # expect the "add self-hosted sourcing services" commit
git diff HEAD~1 --stat          # expect ONLY compose.kevbox.yaml + deploy/mediafusion-postgres-init.sql
```

- [ ] **Step 2: Pre-flight — host port conflicts**

Run: `ss -ltn | grep -E ':(9696|8000|8181)\s'`
Expected: empty (ports free). If not, change the host-side port in compose and the matching nginx/tunnel references in later tasks.

- [ ] **Step 3: Add the secrets that don't depend on Prowlarr to `.env`**

Append to `/opt/kevbox/AIOStreams/.env` (generate each value fresh; never reuse or commit):

```bash
{
  echo "ZILEAN_POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "MEDIAFUSION_SECRET_KEY=$(openssl rand -hex 16)"
  echo "MEDIAFUSION_API_PASSWORD=$(openssl rand -hex 16)"
  echo "MEDIAFUSION_POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "KEVBOX_MEDIAFUSION_URL=https://mf.kevbox.dev"
} >> .env
```

- [ ] **Step 4: Validate compose with real env**

Run: `docker compose -f compose.kevbox.yaml config --quiet`
Expected: exit 0. A warning that `PROWLARR_API_KEY` is unset is OK at this stage (set in Task 6).

### Task 6: Prowlarr + FlareSolverr up and wired

- [ ] **Step 1: Start the two services**

```bash
docker compose -f compose.kevbox.yaml up -d prowlarr flaresolverr
docker compose -f compose.kevbox.yaml ps prowlarr flaresolverr   # both Up
```

- [ ] **Step 2: Grab the Prowlarr API key and finish `.env`**

```bash
PROWLARR_KEY=$(docker exec prowlarr sh -c "grep -o '<ApiKey>[^<]*' /config/config.xml | cut -c9-")
echo "PROWLARR_API_KEY=${PROWLARR_KEY}"            # sanity: 32 hex chars
{
  echo "PROWLARR_API_KEY=${PROWLARR_KEY}"
  echo "BUILTIN_PROWLARR_URL=http://prowlarr:9696"
  echo "BUILTIN_PROWLARR_API_KEY=${PROWLARR_KEY}"
} >> .env
```

- [ ] **Step 3: First-run UI setup (from your machine, via SSH tunnel)**

```bash
ssh -L 9696:127.0.0.1:9696 persovps
# then open http://localhost:9696
```

In the setup wizard: Authentication = Forms (Login Page), pick a username + strong password (password manager). Then Settings → General → Analytics: off → Save.

- [ ] **Step 4: Register FlareSolverr as an indexer proxy**

UI: Settings → Indexers → `+` (Add Indexer Proxy) → FlareSolverr:
- Name: `flaresolverr`
- Tags: `cf`
- Host: `http://flaresolverr:8191`
- Save (it tests automatically; expect green).

- [ ] **Step 5: Add the curated indexer set**

UI: Indexers → Add Indexer. Add each, Test, Save. Starting set (all public, no accounts):

| Indexer | Tag | Note |
|---|---|---|
| 1337x | `cf` | Cloudflare — needs the proxy tag |
| The Pirate Bay | — | |
| YTS | — | |
| EZTV | — | |
| TheRARBG | — | |
| LimeTorrents | — | |
| Nyaa.si | — | anime |
| BitSearch | — | DHT |
| Torlock | — | |
| TorrentDownload | — | |
| RuTor | — | |
| Knaben | — | meta-search — replaces the retired in-process builtin |
| TorrentGalaxy (search the catalog for "galaxy"; add the variant that exists) | `cf` if Test fails without it | replaces the retired in-process builtin |

Rules of thumb: if Test fails with a Cloudflare/403 error, add the `cf` tag and re-Test. If an indexer's site is dead, skip it — coverage is the set, not any single site.

- [ ] **Step 6: Verify search end-to-end through Prowlarr**

On the VPS:

```bash
source <(grep ^PROWLARR_API_KEY .env | sed 's/^/export /')
curl -s -H "X-Api-Key: $PROWLARR_API_KEY" \
  'http://127.0.0.1:9696/api/v1/search?query=the%20matrix%201999&type=search&limit=20' | jq length
```

Expected: a number > 0.

- [ ] **Step 7: Restart kevbox so the builtin picks up the preconfigured instance**

```bash
docker compose -f compose.kevbox.yaml up -d --force-recreate kevbox
docker logs kevbox 2>&1 | grep -i 'preconfigured indexers'
```

Expected: a log line like `Fetched N preconfigured indexers` (N = count you enabled). The family template doesn't reference Prowlarr yet — this only proves the wiring before cutover.

### Task 7: Zilean up + first import

- [ ] **Step 1: Start the Zilean stack**

```bash
docker compose -f compose.kevbox.yaml up -d zilean-postgres zilean
docker logs -f zilean   # watch: DMM hashlist pages importing; Ctrl-C to detach
```

The first full DMM + IMDb import takes **several hours** and runs incrementally on the built-in hourly scheduler (resumes if interrupted). RAM check while it runs: `docker stats --no-stream zilean zilean-postgres`. You can proceed to Tasks 8–9 in parallel — but see the Task 9 note about not racing both first imports at once on purpose if RAM looks tight.

- [ ] **Step 2: Verify the Torznab endpoint AIOStreams will use**

```bash
curl -s 'http://127.0.0.1:8181/torznab/api?t=caps' | grep -o 'imdbid' | head -1
curl -s 'http://127.0.0.1:8181/torznab/api?t=search&q=the+matrix' | grep -c '<item>'
```

Expected: `imdbid`, and (once the import has made progress) an item count > 0.

- [ ] **Step 3: Flip kevbox to the local Zilean — ONLY after the first import completes**

Import is done when `docker logs zilean` shows the scheduled scrape finding no missing pages (subsequent hourly runs finish quickly). Then:

```bash
echo "BUILTIN_ZILEAN_URL=http://zilean:8181" >> .env
docker compose -f compose.kevbox.yaml up -d --force-recreate kevbox
```

Until this step kevbox keeps using the public Zilean instance — zero coverage gap.

### Task 8: Public vhost for MediaFusion (`mf.kevbox.dev`)

- [ ] **Step 1: DNS**

At the kevbox.dev DNS provider, add an A record: `mf.kevbox.dev` → the VPS IPv4 (same address `streams.kevbox.dev` points at). Verify: `dig +short mf.kevbox.dev` returns it.

- [ ] **Step 2: nginx vhost**

Create `/etc/nginx/sites-available/mf.kevbox.dev`:

```nginx
server {
    listen 80;
    server_name mf.kevbox.dev;

    # Playback URLs embed per-user tokens — never log them.
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mf.kevbox.dev /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

- [ ] **Step 3: TLS**

```bash
sudo certbot --nginx -d mf.kevbox.dev
```

Expected: cert issued, vhost rewritten for 443. (Backend 502 until Task 9 is fine — certbot doesn't need it.)

### Task 9: MediaFusion stack up

> RAM courtesy note: MediaFusion's worker imports IMDb datasets on first boot
> (several GB into Postgres). If Zilean's first import is still in its heavy
> phase, `docker stats` first; with < 2 GiB free + swap untouched, just wait
> for Zilean before starting MediaFusion.

- [ ] **Step 1: Start the stack**

```bash
docker compose -f compose.kevbox.yaml up -d mediafusion-postgres mediafusion-redis mediafusion mediafusion-worker
docker logs -f mediafusion         # watch migrations apply; Ctrl-C to detach
docker logs -f mediafusion-worker  # watch the IMDb import kick off
```

- [ ] **Step 2: Verify health + public manifest**

```bash
curl -fsS http://127.0.0.1:8000/health && echo OK
curl -fsS https://mf.kevbox.dev/health && echo PUBLIC-OK
curl -s https://mf.kevbox.dev/manifest.json | jq -r .name
```

Expected: both `OK`s and the MediaFusion addon name. First boot can take many minutes (healthcheck start_period is 20m) — if `/health` isn't up yet, watch the logs rather than restarting.

- [ ] **Step 3: Resource snapshot**

```bash
docker stats --no-stream
free -h
```

Expected: total new-stack usage in the 2–3 GiB range; swap mostly unused.

### Task 10: Cutover — new template goes live

- [ ] **Step 1: Pre-flight the env**

Every var the new template and builtins need must be present:

```bash
grep -E '^(BUILTIN_PROWLARR_URL|BUILTIN_PROWLARR_API_KEY|BUILTIN_ZILEAN_URL|KEVBOX_MEDIAFUSION_URL)=' .env | sed 's/=.*/=<set>/'
```

Expected: all four lines print.

- [ ] **Step 2: Pull the remaining commits and recreate kevbox**

```bash
git pull --ff-only origin kevbox    # template + tests + docs commits land
docker compose -f compose.kevbox.yaml up -d --build kevbox
docker logs kevbox 2>&1 | tail -20
```

Expected: clean boot — no `kevbox template` errors (a broken template fails boot by design), and the `Fetched N preconfigured indexers` line again.

- [ ] **Step 3: Verify a member manifest and stream response**

```bash
 read -s PMKEY   # paste your Premiumize API key (leading space keeps it out of history)
 curl -s "https://streams.kevbox.dev/stremio/k/kevin/${PMKEY}/manifest.json" | jq -r .name
 curl -s "https://streams.kevbox.dev/stremio/k/kevin/${PMKEY}/stream/movie/tt0133093.json" -o /tmp/streams.json
 for a in Prowlarr MediaFusion Zilean Torrentio Peerflix TorrentsDB StremThru; do printf '%-12s %s\n' "$a" "$(grep -c "$a" /tmp/streams.json)"; done
 for a in Comet Sootio; do printf '%-12s %s\n' "$a" "$(grep -c "$a" /tmp/streams.json)"; done
 rm /tmp/streams.json; unset PMKEY
```

Expected: name `Kevbox`; non-zero counts for the seven kept/new addons (Zilean serves from the public instance until Task 7 Step 3 flips it, so it counts either way; MediaFusion may be sparse until its background scrape cycles fill the local DB); **zero** for Comet and Sootio. (`Knaben`/`TorrentGalaxy` strings may legitimately appear inside other addons' provider labels — Comet/Sootio absence is the real removal check, plus the addon-statistics streams at the bottom of the list, which name each responding addon.)

### Task 11: End-to-end verification + wrap-up

- [ ] **Step 1: Real playback test (operator, in Stremio)**

In your own Stremio (kevin's install URL): open a popular movie and a current
series episode → results appear within the timeout, grouped per the template
(≤3 per resolution per addon, ≤4 GB) → pick a Prowlarr-sourced and a
MediaFusion-sourced stream → both start within a few seconds via Premiumize.

- [ ] **Step 2: Confirm the dropped public dependencies are really gone**

`docker logs kevbox 2>&1 | grep -icE 'comet|sootio'` over a fresh request window — expect 0 (no fetches to dropped addons).

- [ ] **Step 3: Monitoring (optional but cheap)**

In uptime-kuma add HTTP monitors: `https://mf.kevbox.dev/health` and `https://streams.kevbox.dev` (existing). Prowlarr/Zilean are loopback-bound; to monitor them, attach the uptime-kuma container to the compose network (`docker network connect aiostreams_default uptime-kuma` — check the exact network name with `docker network ls`) and monitor `http://prowlarr:9696/ping` and `http://zilean:8181/healthchecks/ping`.

- [ ] **Step 4: Family note**

Dropping Sootio removes its "Premiumize Downloads" catalogs from member
manifests; Stremio clients cache manifests, so stale catalog rows may linger
until members reinstall their Kevbox URL. Harmless — mention it if anyone asks.

- [ ] **Step 5: Final snapshot**

```bash
free -h; df -h /; docker stats --no-stream
```

Record steady-state numbers next to the spec's §7 estimates. If reality diverges badly (e.g. > 4 GiB), revisit `firecrawl-api` (capped at 8 GiB) as the reclaim option.

---

## Rollback notes

- **Template-level rollback (fast):** `git revert` the Task 2 commit, push, `git pull` on the VPS — the bind-mounted template reverts on next request; recreate kevbox to restore env-independence. The old lineup needs no new env vars, so this is always safe.
- **Zilean rollback:** remove `BUILTIN_ZILEAN_URL` from `.env`, recreate kevbox → falls back to the public default instance.
- **MediaFusion rollback:** set `KEVBOX_MEDIAFUSION_URL=https://mediafusion.elfhosted.com` in `.env` (the prior public instance), recreate kevbox.
- **Full infra rollback:** `docker compose -f compose.kevbox.yaml down prowlarr flaresolverr zilean zilean-postgres mediafusion mediafusion-worker mediafusion-postgres mediafusion-redis` (named volumes survive; add `-v` only when certain).
