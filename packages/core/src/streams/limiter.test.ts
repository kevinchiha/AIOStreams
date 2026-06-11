import { describe, it, expect } from 'vitest';
import type { ParsedStream } from '../db/schemas.js';
import { selectSizeBucketRemovals } from './sizeBuckets.js';

const GB = 1_000_000_000;

function mk(
  id: string,
  sizeGB: number | undefined,
  resolution: string,
  addonId: string
): ParsedStream {
  return {
    id,
    type: 'debrid',
    size: sizeGB === undefined ? undefined : sizeGB * GB,
    parsedFile: { resolution } as any,
    addon: { preset: { id: addonId } } as any,
  } as unknown as ParsedStream;
}

const cfg = {
  enabled: true,
  bandSizeBytes: 0.5 * GB,
  maxBytes: 4 * GB,
  perBand: 1,
};

function survivors(
  streams: ParsedStream[],
  config: any = cfg,
  global?: number
): string[] {
  const remove = selectSizeBucketRemovals(streams, config, global);
  return streams.filter((_, i) => !remove.has(i)).map((s) => s.id);
}

describe('selectSizeBucketRemovals', () => {
  it('keeps the largest stream per 0.5GB band, per addon x resolution', () => {
    const streams = [
      mk('a', 0.2, '1080p', 'A'), // band 0
      mk('b', 0.4, '1080p', 'A'), // band 0 (larger -> wins)
      mk('c', 0.6, '1080p', 'A'), // band 1
      mk('d', 1.2, '1080p', 'A'), // band 2
      mk('e', 1.7, '1080p', 'A'), // band 3
    ];
    expect(survivors(streams)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('buckets independently per addon and per resolution', () => {
    const streams = [
      mk('a', 0.4, '1080p', 'A'),
      mk('b', 0.2, '1080p', 'B'),
      mk('c', 0.3, '720p', 'A'),
    ];
    expect(new Set(survivors(streams))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('drops streams at or above maxBytes', () => {
    const streams = [
      mk('a', 1.2, '1080p', 'A'),
      mk('big', 5, '1080p', 'A'), // >= 4GB
    ];
    expect(survivors(streams)).toEqual(['a']);
  });

  it('keeps perBand>1 largest per band', () => {
    const streams = [
      mk('a', 1.1, '1080p', 'A'), // band 2
      mk('b', 1.3, '1080p', 'A'), // band 2
      mk('c', 1.4, '1080p', 'A'), // band 2
      mk('d', 1.6, '1080p', 'A'), // band 3
    ];
    expect(new Set(survivors(streams, { ...cfg, perBand: 2 }))).toEqual(
      new Set(['b', 'c', 'd'])
    );
  });

  it('applies a global cap after bucketing, in input order', () => {
    const streams = [
      mk('a', 0.4, '1080p', 'A'),
      mk('b', 0.9, '1080p', 'A'),
      mk('c', 1.4, '1080p', 'A'),
      mk('d', 1.9, '1080p', 'A'),
    ];
    expect(survivors(streams, cfg, 2)).toEqual(['a', 'b']);
  });

  it('buckets missing-size streams into their own band', () => {
    const streams = [
      mk('a', 1.2, '1080p', 'A'),
      mk('x', undefined, '1080p', 'A'),
      mk('y', undefined, '1080p', 'A'),
    ];
    const ids = survivors(streams);
    expect(ids).toContain('a');
    expect(ids.filter((id) => id === 'x' || id === 'y')).toHaveLength(1);
  });
});
