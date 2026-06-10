import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  substituteEnvPlaceholders,
  loadKevboxTemplate,
  checkKevboxTemplate,
  kevboxMembers,
} from './kevboxTemplate.js';

const writeTemplate = (content: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kevbox-test-'));
  const file = path.join(dir, 'kevbox.config.json');
  writeFileSync(file, content);
  return file;
};

describe('substituteEnvPlaceholders', () => {
  it('substitutes ${VAR} from env', () => {
    const result = substituteEnvPlaceholders('{"a":"${FOO}"}', { FOO: 'bar' });
    expect(result).toBe('{"a":"bar"}');
  });

  it('JSON-escapes substituted values', () => {
    const result = substituteEnvPlaceholders('{"a":"${FOO}"}', {
      FOO: 'with "quotes" and \\backslash',
    });
    expect(JSON.parse(result)).toEqual({ a: 'with "quotes" and \\backslash' });
  });

  it('throws listing every missing variable', () => {
    expect(() =>
      substituteEnvPlaceholders('{"a":"${MISS_A}","b":"${MISS_B}"}', {})
    ).toThrow(/MISS_A.*MISS_B|MISS_B.*MISS_A/);
  });

  it('leaves non-placeholder text untouched', () => {
    const raw = '{"expr":"count(cached(streams)) == 0 ? uncached(streams) : []"}';
    expect(substituteEnvPlaceholders(raw, {})).toBe(raw);
  });
});

describe('loadKevboxTemplate', () => {
  it('loads and parses a template file', () => {
    const file = writeTemplate('{"presets":[],"services":[],"name":"${N}"}');
    const template = loadKevboxTemplate(file, { N: 'x' });
    expect(template).toEqual({ presets: [], services: [], name: 'x' });
  });

  it('returns the cached object for an unchanged mtime', () => {
    const file = writeTemplate('{"presets":[]}');
    const first = loadKevboxTemplate(file, {});
    const second = loadKevboxTemplate(file, {});
    expect(second).toBe(first);
  });

  it('reloads when the file mtime changes', () => {
    const file = writeTemplate('{"v":1}');
    expect(loadKevboxTemplate(file, {})).toEqual({ v: 1 });
    writeFileSync(file, '{"v":2}');
    const future = Date.now() / 1000 + 10;
    utimesSync(file, future, future);
    expect(loadKevboxTemplate(file, {})).toEqual({ v: 2 });
  });

  it('throws a path-bearing error on invalid JSON', () => {
    const file = writeTemplate('{nope');
    expect(() => loadKevboxTemplate(file, {})).toThrow(file);
  });
});

describe('checkKevboxTemplate', () => {
  it('passes a template with a premiumize service and presets', () => {
    const file = writeTemplate(
      '{"presets":[{"type":"torrentio"}],"services":[{"id":"premiumize","enabled":true,"credentials":{}}]}'
    );
    expect(checkKevboxTemplate(file, {})).toEqual({ ok: true });
  });

  it('fails when the file does not exist', () => {
    const result = checkKevboxTemplate('/nonexistent/kevbox.config.json', {});
    expect(result.ok).toBe(false);
  });

  it('fails when there is no premiumize service entry', () => {
    const file = writeTemplate('{"presets":[{"type":"torrentio"}],"services":[]}');
    const result = checkKevboxTemplate(file, {});
    expect(result).toEqual({
      ok: false,
      reason: 'template has no premiumize service entry',
    });
  });

  it('fails when there are no presets', () => {
    const file = writeTemplate(
      '{"presets":[],"services":[{"id":"premiumize"}]}'
    );
    const result = checkKevboxTemplate(file, {});
    expect(result).toEqual({ ok: false, reason: 'template has no presets' });
  });

  it('reports missing env vars as the failure reason', () => {
    const file = writeTemplate('{"presets":[1],"services":[{"id":"premiumize"}],"x":"${NOPE}"}');
    const result = checkKevboxTemplate(file, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('NOPE');
  });

  it('fails on a duplicate preset instanceId', () => {
    const file = writeTemplate(
      '{"presets":[{"instanceId":"001"},{"instanceId":"001"}],"services":[{"id":"premiumize"}]}'
    );
    const result = checkKevboxTemplate(file, {});
    expect(result).toEqual({
      ok: false,
      reason: 'duplicate preset instanceId "001"',
    });
  });

  it('fails on a dotted preset instanceId', () => {
    const file = writeTemplate(
      '{"presets":[{"instanceId":"a.b"}],"services":[{"id":"premiumize"}]}'
    );
    const result = checkKevboxTemplate(file, {});
    expect(result).toEqual({
      ok: false,
      reason: 'preset instanceId "a.b" must not contain "."',
    });
  });
});

describe('kevboxMembers', () => {
  it('parses a comma-separated allowlist', () => {
    expect(kevboxMembers({ KEVBOX_MEMBERS: 'kevin,mum' })).toEqual([
      'kevin',
      'mum',
    ]);
  });

  it('trims whitespace and drops blank entries', () => {
    expect(kevboxMembers({ KEVBOX_MEMBERS: ' a , , b ,' })).toEqual(['a', 'b']);
  });

  it('returns an empty array when unset or empty (kevbox disabled)', () => {
    expect(kevboxMembers({})).toEqual([]);
    expect(kevboxMembers({ KEVBOX_MEMBERS: '' })).toEqual([]);
    expect(kevboxMembers({ KEVBOX_MEMBERS: '   ' })).toEqual([]);
  });
});
