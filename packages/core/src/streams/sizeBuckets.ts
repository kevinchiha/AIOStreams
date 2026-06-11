import type { ParsedStream } from '../db/schemas.js';
import { shouldPassthroughStage } from './utils.js';

export interface SizeBucketsConfig {
  enabled?: boolean;
  /** Width of each size band, in bytes (e.g. 0.5 GB). */
  bandSizeBytes: number;
  /** Streams at or above this size are dropped entirely. */
  maxBytes: number;
  /** How many streams to keep per band (largest first). Defaults to 1. */
  perBand?: number;
}

/**
 * Returns the indices of `streams` to REMOVE under size-bucket limiting.
 *
 * Within each `(addon preset id, resolution)` group, the largest `perBand`
 * streams per `bandSizeBytes`-wide size band are kept and the rest dropped;
 * streams `>= maxBytes` are always dropped. Streams that pass through the
 * `limit` stage (or are `info` rows) are exempt — never removed and never
 * counted toward `global`. When `global` is set, at most `global` streams
 * survive overall, kept in input order.
 *
 * Pure (no IO/config/logger), so the selection logic is unit-testable in
 * isolation from the limiter's wiring.
 */
export function selectSizeBucketRemovals(
  streams: ParsedStream[],
  config: SizeBucketsConfig,
  global?: number
): Set<number> {
  const remove = new Set<number>();
  const bandSize = config.bandSizeBytes;
  const maxBytes = config.maxBytes;
  const perBand = config.perBand ?? 1;

  const isExempt = (stream: ParsedStream) =>
    stream.type === 'info' || shouldPassthroughStage(stream, 'limit');

  // Group surviving indices by `resolution|addon|band`, in input order.
  const bands = new Map<string, number[]>();
  streams.forEach((stream, index) => {
    if (isExempt(stream)) return;

    const size = stream.size;
    let band: string;
    if (typeof size !== 'number' || Number.isNaN(size)) {
      band = 'nosize';
    } else if (size >= maxBytes) {
      remove.add(index); // outside the configured range
      return;
    } else {
      band = String(Math.floor(size / bandSize));
    }

    const resolution = stream.parsedFile?.resolution || 'Unknown';
    const addonId = stream.addon.preset.id;
    const key = `${resolution}|${addonId}|${band}`;
    const existing = bands.get(key);
    if (existing) existing.push(index);
    else bands.set(key, [index]);
  });

  // Within each band, keep the `perBand` largest by size; drop the rest.
  for (const indices of bands.values()) {
    if (indices.length <= perBand) continue;
    const bySizeDesc = [...indices].sort(
      (a, b) => (streams[b].size ?? 0) - (streams[a].size ?? 0)
    );
    for (const idx of bySizeDesc.slice(perBand)) {
      remove.add(idx);
    }
  }

  // Global cap: keep at most `global` survivors, in input order.
  if (global && global > 0) {
    let kept = 0;
    streams.forEach((stream, index) => {
      if (remove.has(index) || isExempt(stream)) return;
      if (kept >= global) {
        remove.add(index);
        return;
      }
      kept++;
    });
  }

  return remove;
}
