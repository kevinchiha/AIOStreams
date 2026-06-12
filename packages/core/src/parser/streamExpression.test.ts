import { describe, it, expect } from 'vitest';
import { distinctAddonCount } from './addonCount.js';
import type { ParsedStream } from '../db/schemas.js';

// Minimal stub: distinctAddonCount only reads `addon.name`.
const streamFrom = (addonName: string): ParsedStream =>
  ({ type: 'http', addon: { name: addonName } }) as unknown as ParsedStream;

// Build `count` streams from each of the named addons.
const pool = (...addons: Array<[string, number]>): ParsedStream[] =>
  addons.flatMap(([name, count]) =>
    Array.from({ length: count }, () => streamFrom(name))
  );

// distinctAddonCount() backs the kevbox fast-exit clause. The live condition is
// `countAddons(totalStreams, 6) >= 3` — stop only once 3 distinct addons have
// EACH returned at least 6 streams (not once 3 addons merely finished, which
// `count(queriedAddons)` wrongly counted, including addons that returned nothing).
describe('distinctAddonCount()', () => {
  describe('default (minPerAddon = 1) — any contribution counts', () => {
    it('returns 1 when every stream comes from one addon (the bug)', () => {
      expect(distinctAddonCount(pool(['Torz', 3]))).toBe(1);
    });

    it('counts each distinct contributing addon once', () => {
      expect(
        distinctAddonCount(pool(['Torrentio', 1], ['Comet', 1], ['MediaFusion', 1]))
      ).toBe(3);
    });

    it('ignores duplicate streams from the same addon', () => {
      expect(distinctAddonCount(pool(['Torrentio', 2], ['Comet', 1]))).toBe(2);
    });

    it('returns 0 for an empty pool', () => {
      expect(distinctAddonCount([])).toBe(0);
    });
  });

  describe('minPerAddon = 3 — addons must each return 3+ streams', () => {
    it('counts only addons that returned at least 3 streams', () => {
      // 3 addons with 3+ each -> qualifies.
      expect(
        distinctAddonCount(pool(['A', 3], ['B', 5], ['C', 3]), 3)
      ).toBe(3);
    });

    it('excludes addons that returned fewer than 3 streams', () => {
      // A=3 (ok), B=2 (no), C=1 (no) -> only 1 qualifying addon.
      expect(
        distinctAddonCount(pool(['A', 3], ['B', 2], ['C', 1]), 3)
      ).toBe(1);
    });

    it('many streams from one addon is still just one addon', () => {
      expect(distinctAddonCount(pool(['A', 20]), 3)).toBe(1);
    });
  });

  describe('minPerAddon = 6 — the live kevbox bar', () => {
    it('counts only the 3+ addons that each returned 6+ streams', () => {
      // A=6 (ok), B=9 (ok), C=6 (ok), D=5 (no) -> 3 qualifying addons.
      expect(
        distinctAddonCount(pool(['A', 6], ['B', 9], ['C', 6], ['D', 5]), 6)
      ).toBe(3);
    });

    it('a rich single addon (e.g. one indexer) does not satisfy the bar alone', () => {
      // 30 streams but all one addon -> 1 < 3, fast-exit must NOT trip.
      expect(distinctAddonCount(pool(['A', 30]), 6)).toBe(1);
    });
  });
});
