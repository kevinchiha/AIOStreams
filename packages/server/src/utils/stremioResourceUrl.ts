/**
 * Matches a Stremio resource-request URL — the path the rate-limit handler in
 * middlewares/errors.ts rewrites into a playable "error stream" instead of raw
 * 429 JSON. Supports BOTH the stock `:uuid/:encryptedPassword` form and the
 * kevbox `k/:name/:apiKey` form; capture group 1 is the resource type.
 *
 * Kept in this core-free module so it is unit-testable without the
 * @aiostreams/core env bootstrap, and shared so the kevbox name/key shapes
 * here cannot silently drift from their source of truth.
 *
 * SYNC NOTE: the `[a-z0-9-]{1,20}` and `[A-Za-z0-9_-]{8,128}` fragments mirror
 * KEVBOX_NAME_REGEX / KEVBOX_API_KEY_REGEX in kevboxUserData.ts — keep in sync.
 */
export const STREMIO_RESOURCE_REQUEST_REGEX =
  /^\/stremio\/(?:[0-9a-fA-F-]{36}\/[A-Za-z0-9+/=]+|k\/[a-z0-9-]{1,20}\/[A-Za-z0-9_-]{8,128})\/(stream|meta|addon_catalog|subtitles|catalog)\/[^/]+\/[^/]+(?:\/[^/]+)?\.json\/?$/;
