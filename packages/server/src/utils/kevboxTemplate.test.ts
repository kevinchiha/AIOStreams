import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, statSync } from 'node:fs';
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

describe('kevboxMembers file source', () => {
  const writeMembers = (content: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kevbox-members-'));
    const file = path.join(dir, 'members.json');
    writeFileSync(file, content);
    return file;
  };

  it('uses a non-empty members.json file when KEVBOX_MEMBERS_FILE is set', () => {
    const file = writeMembers('["alice","bob"]');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file, KEVBOX_MEMBERS: 'zzz' })).toEqual([
      'alice',
      'bob',
    ]);
  });

  it('falls back to KEVBOX_MEMBERS env when the file is missing', () => {
    expect(
      kevboxMembers({ KEVBOX_MEMBERS_FILE: '/no/such/members.json', KEVBOX_MEMBERS: 'a,b' }),
    ).toEqual(['a', 'b']);
  });

  it('falls back to env when the file is an empty array', () => {
    const file = writeMembers('[]');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file, KEVBOX_MEMBERS: 'a' })).toEqual(['a']);
  });

  it('falls back to env when the file is 0-byte / whitespace', () => {
    const file = writeMembers('   \n');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file, KEVBOX_MEMBERS: 'a' })).toEqual(['a']);
  });

  it('falls back to env on malformed JSON (no throw)', () => {
    const file = writeMembers('{not json');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file, KEVBOX_MEMBERS: 'a' })).toEqual(['a']);
  });

  it('drops invalid names but keeps valid ones', () => {
    const file = writeMembers('["good","BAD UPPER","ok.name","has space"]');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file })).toEqual(['good', 'ok.name']);
  });

  it('reloads when the file changes (mtime or size cache-bust)', () => {
    const file = writeMembers('["one"]');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file })).toEqual(['one']);
    writeFileSync(file, '["one","two"]');
    const future = Date.now() / 1000 + 10;
    utimesSync(file, future, future);
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file })).toEqual(['one', 'two']);
  });

  it('ignores KEVBOX_MEMBERS_FILE when unset (pure env behavior)', () => {
    expect(kevboxMembers({ KEVBOX_MEMBERS: 'x , y , ' })).toEqual(['x', 'y']);
  });

  it('ignores a sibling temp file (reads only members.json)', () => {
    // kevbox-admin writes a sibling `.tmp-<pid>-members.json` then atomic-renames it
    // onto members.json. A leftover/in-progress temp sibling must never be picked up —
    // KEVBOX_MEMBERS_FILE points at members.json exactly, so only that name is read.
    const dir = mkdtempSync(path.join(tmpdir(), 'kevbox-members-'));
    const file = path.join(dir, 'members.json');
    writeFileSync(file, '["alice"]');
    writeFileSync(path.join(dir, '.tmp-12345-members.json'), '["mallory"]');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file, KEVBOX_MEMBERS: 'zzz' })).toEqual([
      'alice',
    ]);
  });

  it('boot fail-loud: empty RESOLVED list after file→env fallback yields []', () => {
    // Spec §7 fail-loud: when neither the file nor env yields any name, the resolved
    // list is empty (server.ts then refuses to boot). Empty file ([]) falls back to env,
    // and env is also empty → kevboxMembers() returns [] (not a partial/stale list).
    const file = writeMembers('[]');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file, KEVBOX_MEMBERS: '' })).toEqual([]);
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file, KEVBOX_MEMBERS: '   ,  , ' })).toEqual(
      [],
    );
  });

  it('reloads on a SIZE-ONLY change (same mtime, different length)', () => {
    // Exercises the `cached.size === stat.size` cache term specifically: force the SAME
    // mtime back onto the file after writing different-length content. If the size check
    // were dropped, the stale cached names would be returned and this test would fail.
    const file = writeMembers('["one"]');
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file })).toEqual(['one']);
    const { mtimeMs } = statSync(file); // capture the cached mtime
    writeFileSync(file, '["one","two"]'); // longer content → different size
    const sameMtimeSec = mtimeMs / 1000;
    utimesSync(file, sameMtimeSec, sameMtimeSec); // force mtime back to the cached value
    expect(kevboxMembers({ KEVBOX_MEMBERS_FILE: file })).toEqual(['one', 'two']);
  });
});
