import { describe, expect, it } from 'vitest';
import { STREMIO_RESOURCE_REQUEST_REGEX } from './stremioResourceUrl.js';

const KEY = 'dummykey12345';

describe('STREMIO_RESOURCE_REQUEST_REGEX', () => {
  it('matches kevbox resource URLs and captures the resource type', () => {
    for (const r of ['stream', 'meta', 'catalog', 'subtitles', 'addon_catalog']) {
      const m = STREMIO_RESOURCE_REQUEST_REGEX.exec(
        `/stremio/k/mum/${KEY}/${r}/movie/tt0111161.json`
      );
      expect(m, `${r} should match`).not.toBeNull();
      expect(m?.[1]).toBe(r);
    }
  });

  it('matches email local-part member names', () => {
    for (const name of ['kevin.chiha', 'alecco_999', 'member+tv']) {
      const m = STREMIO_RESOURCE_REQUEST_REGEX.exec(
        `/stremio/k/${name}/${KEY}/stream/movie/tt0111161.json`
      );
      expect(m?.[1]).toBe('stream');
    }
  });

  it('matches the stock :uuid/:encryptedPassword form', () => {
    const m = STREMIO_RESOURCE_REQUEST_REGEX.exec(
      '/stremio/12345678-1234-1234-1234-123456789012/cGFzcw==/stream/movie/tt0111161.json'
    );
    expect(m?.[1]).toBe('stream');
  });

  it('does not match manifest.json or configure', () => {
    expect(
      STREMIO_RESOURCE_REQUEST_REGEX.test(`/stremio/k/mum/${KEY}/manifest.json`)
    ).toBe(false);
    expect(
      STREMIO_RESOURCE_REQUEST_REGEX.test(`/stremio/k/mum/${KEY}/configure`)
    ).toBe(false);
  });

  it('rejects out-of-bounds kevbox name/key shapes (drift guard vs KEVBOX_*_REGEX)', () => {
    // name > 64 chars
    expect(
      STREMIO_RESOURCE_REQUEST_REGEX.test(
        `/stremio/k/${'a'.repeat(65)}/${KEY}/stream/movie/tt0111161.json`
      )
    ).toBe(false);
    // key < 8 chars
    expect(
      STREMIO_RESOURCE_REQUEST_REGEX.test(
        '/stremio/k/mum/short/stream/movie/tt0111161.json'
      )
    ).toBe(false);
  });
});
