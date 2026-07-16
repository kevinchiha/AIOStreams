# AI Search (self-hosted)

Self-hosted [`itcon-pty-au/stremio-ai-search`](https://github.com/itcon-pty-au/stremio-ai-search)
— the "AI Search" Stremio addon — replacing the public
`https://stremio.itcon.au/aisearch`. Runs alongside the kevbox stack on persovps
behind native nginx + certbot.

**Why self-host is clean here:** fully BYOK / stateless — the server holds no API
keys (users enter OpenRouter/TMDB keys at `/configure`, encrypted into their
install URL). One small Node container, no DB/Redis, nothing sensitive to guard,
no poster forward-proxy to harden.

Pinned to upstream `main` @ `7172139` (2026-06-19). No upstream image is published,
so we build from that commit via its own `Dockerfile` (`node:23`). The repo is
unmaintained upstream — pin deliberately.

## Deploy

Run on the VPS from this directory (`/opt/kevbox/AIOStreams/deploy/aisearch`).

1. **Env** — create `.env` (gitignored) and set a *permanent* key:
   ```bash
   cp .env.example .env
   printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> .env   # or edit by hand
   chmod 600 .env
   ```
   ⚠️ Never change `ENCRYPTION_KEY` afterwards — it invalidates every install URL.
   `HOST` is already set to `aisearch.kevbox.dev`.

2. **Build + start:**
   ```bash
   docker compose -f compose.aisearch.yaml up -d --build
   docker compose -f compose.aisearch.yaml ps                          # wait for healthy
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7000/     # local sanity
   ```

3. **DNS** — add an A record `aisearch.kevbox.dev → 185.223.31.163` at your DNS
   provider (external; can't be done from the box).

4. **nginx + TLS:**
   ```bash
   sudo cp nginx/aisearch.kevbox.dev.conf /etc/nginx/sites-available/aisearch.kevbox.dev
   sudo ln -s /etc/nginx/sites-available/aisearch.kevbox.dev /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d aisearch.kevbox.dev     # injects the 443 + 80→443 blocks
   ```

5. **Configure + install** — open `https://aisearch.kevbox.dev/configure`, pick
   **OpenAI-compatible**, and enter:
   - **API Key:** your OpenRouter key
   - **Base URL:** `https://openrouter.ai/api/v1`
   - **Model:** `deepseek/deepseek-v4-flash`  (fallback `google/gemini-3.1-flash-lite`)
   - **TMDB API Key**
   - **AI Temperature:** `0.1`–`0.2`

   Then install the generated URL into Stremio.

## Gotchas

- **reCAPTCHA:** upstream's `/configure` flow references a `recaptchaToken`. Confirm
  your instance can generate an install URL without reCAPTCHA keys (it should, since
  none are set). If it blocks URL generation, that's the one thing to patch.
- **Egress (if you run default-deny like the old metadata box):** allowlist
  `openrouter.ai` + `api.themoviedb.org` (+ `api.trakt.tv` if you enable Trakt).
- **IPv6 hang:** already handled — `NODE_OPTIONS=--dns-result-order=ipv4first` is set
  in compose (same trap as the kevbox service; without it OpenRouter/TMDB calls hang).
- **Trakt:** optional. If enabled, set `TRAKT_CLIENT_ID/SECRET` in `.env` and
  uncomment the `aisearch-data` volume in compose so OAuth tokens persist.
- **No boot/backup systemd units needed:** single stateless container, so
  `restart: unless-stopped` brings it back on reboot; nothing to back up.

## Update

```bash
# Bump the #<sha> in compose.aisearch.yaml (build.context AND the image tag) to a
# newer upstream commit, then rebuild:
docker compose -f compose.aisearch.yaml up -d --build
docker image rm aisearch:<old-sha>     # drop the superseded tag (NO host-wide prune)
```
