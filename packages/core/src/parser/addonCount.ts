import type { ParsedStream } from '../db/schemas.js';

/**
 * Number of DISTINCT addons that contributed at least `minPerAddon` streams to
 * the given pool. Defaults to 1, i.e. "addons that returned anything".
 *
 * This is deliberately different from `count(queriedAddons)` in the exit
 * condition: `queriedAddons` counts addons that *finished fetching* (including
 * ones that returned nothing), whereas this counts addons that genuinely
 * returned results — and, with `minPerAddon`, only those that returned a
 * meaningful number of them. For sparsely-indexed titles those numbers diverge,
 * and the early-exit should key off real contribution so a single addon's
 * results don't trip a "3 addons" rule.
 *
 * Kept dependency-free (only a type import, which is erased at runtime) so it
 * can be unit-tested in isolation without pulling in the engine's module graph.
 */
export function distinctAddonCount(
  streams: ParsedStream[],
  minPerAddon: number = 1
): number {
  const perAddon = new Map<string, number>();
  for (const stream of streams) {
    const name = stream.addon.name;
    perAddon.set(name, (perAddon.get(name) ?? 0) + 1);
  }

  let qualifying = 0;
  for (const streamCount of perAddon.values()) {
    if (streamCount >= minPerAddon) {
      qualifying++;
    }
  }
  return qualifying;
}
