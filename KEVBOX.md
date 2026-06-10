# Kevbox fork notes

This fork tracks [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams) with
custom edits for a private family deployment.

## Branch model

| Branch   | Role                                                              |
| -------- | ----------------------------------------------------------------- |
| `main`   | Pristine mirror of upstream. Never commit here.                   |
| `kevbox` | `main` + custom edits. All work and deployments happen here.      |

Remotes: `origin` = kevinchiha/AIOStreams (this fork), `upstream` = Viren070/AIOStreams.

## Pulling in a new AIOStreams release

```sh
git fetch upstream --tags
git checkout kevbox
git merge v2.31.0        # merge a tagged release (stable), or upstream/main for bleeding edge
# resolve conflicts if any — should be rare, see "keeping conflicts rare" below
pnpm install && pnpm build && pnpm test
git push
```

Merging (rather than rebasing) means no force-pushes: the server/deploy can always
plain `git pull`, and each upstream sync is a single conflict-resolution pass.

Optionally keep the fork's `main` synced too (cosmetic — kevbox merges straight from
`upstream`, so this is never required):

```sh
git checkout main && git merge --ff-only upstream/main && git push origin main && git checkout kevbox
```

(or just use GitHub's "Sync fork" button.)

## Keeping conflicts rare

- Put custom code in **new files** (new middleware, new route module) wherever possible.
- Keep edits to upstream files down to a few lines (imports, route registration).
- Never reformat or restructure upstream files.

## Seeing exactly what this fork changes

```sh
git diff upstream/main...kevbox
```

## Family install URLs

One URL per member — same shared config, their own Premiumize key:

    https://streams.kevbox.dev/stremio/k/<name>/<premiumizeApiKey>/manifest.json

- `name`: 1-20 chars of `a-z 0-9 -` (e.g. `mum`, `kevin`) AND listed in
  `KEVBOX_MEMBERS` on the server. Unknown names get a friendly error.
  Shows up in logs and as the addon name in Stremio ("Kevbox (Mum)").
- Adding a member: add the name to `KEVBOX_MEMBERS` in `.env`, restart, send
  them their URL. Swapping a key = edit the URL, reinstall.
- Config changes (filters, addons, sorting) are made in `kevbox.config.json`
  → commit → push to origin, then redeploy on the VPS (see "Deploy &
  updates"). The template is bind-mounted, so a change is live on members'
  next request once the container is restarted. Caveat: anything that lives
  in the manifest itself (catalog list, addon name) is cached by Stremio
  clients and may effectively need a reinstall.

## The template

`kevbox.config.json` at the repo root is the single shared config. Secrets are
`${ENV_VAR}` placeholders substituted at load time — never commit real values.

| Env var | Purpose |
| --- | --- |
| `KEVBOX_MEMBERS` | Member allowlist (comma-separated). Required — kevbox is off without it |
| `KEVBOX_TEMPLATE_PATH` | Optional override of the template location (default `<cwd>/kevbox.config.json`; the compose file bind-mounts it to `/app/kevbox.config.json`) |

The shipped template needs **no secrets** — MediaFlow proxy and RPDB posters are
disabled (Premiumize links aren't IP-locked, so MediaFlow only adds VPS
bandwidth; RPDB is just rating badges). Each member's Premiumize key lives in
their URL, not the env.

Want them back later? **RPDB:** set `"posterService": "rpdb"`, add
`"rpdbApiKey": "${KEVBOX_RPDB_KEY}"`, and set `KEVBOX_RPDB_KEY` (free key at
ratingposterdb.com). **MediaFlow:** run a mediaflow-proxy container, set the
template `proxy` to `"enabled": true` with `"url": "${KEVBOX_MEDIAFLOW_URL}"` /
`"credentials": "${KEVBOX_MEDIAFLOW_PASSWORD}"`, and set those env vars.

With `KEVBOX_MEMBERS` set, a broken template **fails server boot** (so the bad
config is caught before redeploy, not at a family member's request).

## VPS environment (.env on the server, never in git)

    BASE_URL=https://streams.kevbox.dev
    SECRET_KEY=<openssl rand -hex 32>
    ADDON_NAME=Kevbox
    ADDON_ID=com.kevbox.stremio
    # Gate the configure page AND anonymous DB-config creation. Kevbox URLs
    # are unaffected: the middleware injects the access key on every request.
    AIOSTREAMS_AUTH_REQUIRED=true
    CONFIG_ACCESS_KEY=<openssl rand -hex 24>
    ENABLE_SEARCH_API=false
    # Must cover the pinned compose subnet so X-Forwarded-For is honored and
    # rate limits are per-client (not one bucket for the whole internet).
    TRUSTED_IPS=172.30.0.0/16,127.0.0.1/32,::1/128
    KEVBOX_MEMBERS=kevin,mum
    # (no MediaFlow/RPDB secrets needed — both disabled in the template)

## Deploy & updates

Deploy: `docker compose -f compose.kevbox.yaml up -d --build` from the repo
checkout on the VPS (binds 127.0.0.1:3127, fronted by the reverse proxy —
whose access log must be OFF for this vhost: the URLs contain PM keys).

Updates are manual: follow the "Pulling in a new AIOStreams release" flow at
the top of this file — `git fetch upstream --tags`, merge a release tag,
`pnpm install && pnpm build && pnpm test`, then redeploy with the same
`docker compose -f compose.kevbox.yaml up -d --build`. Template/config edits
deploy the same way: commit, push to origin, `git pull` on the VPS, redeploy.

Automated upstream syncing (a nightly systemd timer) was intentionally
deferred — an unattended upstream merge can break the fork in ways that need
a human to resolve, so each release is pulled in and tested by hand.
