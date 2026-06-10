import { describe, expect, it } from 'vitest';
import {
  buildKevboxUserData,
  KevboxParamError,
  memberDisplayName,
  syntheticUuid,
} from './kevboxUserData.js';

const UUID_REGEX =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const template = () => ({
  presets: [{ type: 'torrentio', instanceId: '001', enabled: true }],
  services: [
    { id: 'realdebrid', enabled: false, credentials: {} },
    { id: 'premiumize', enabled: false, credentials: {} },
  ],
  excludeUncached: true,
});

const BASE = 'https://streams.kevbox.dev';
const KEY = 'abcDEF123456';

describe('syntheticUuid', () => {
  it('produces a valid, stable UUID per name', () => {
    const a = syntheticUuid('mum');
    expect(a).toMatch(UUID_REGEX);
    expect(syntheticUuid('mum')).toBe(a);
  });

  it('produces different UUIDs for different names', () => {
    expect(syntheticUuid('mum')).not.toBe(syntheticUuid('kevin'));
  });
});

describe('memberDisplayName', () => {
  it('capitalises the first letter', () => {
    expect(memberDisplayName('mum')).toBe('Mum');
    expect(memberDisplayName('kevin-tv')).toBe('Kevin-tv');
  });
});

describe('buildKevboxUserData', () => {
  it('injects the API key into premiumize and enables it', () => {
    const userData = buildKevboxUserData(template(), 'mum', KEY, BASE);
    const premiumize = userData.services?.find((s) => s.id === 'premiumize');
    expect(premiumize).toMatchObject({
      enabled: true,
      credentials: { apiKey: KEY },
    });
  });

  it('leaves other services untouched', () => {
    const userData = buildKevboxUserData(template(), 'mum', KEY, BASE);
    const rd = userData.services?.find((s) => s.id === 'realdebrid');
    expect(rd).toEqual({ id: 'realdebrid', enabled: false, credentials: {} });
  });

  it('does not mutate the template', () => {
    const t = template();
    buildKevboxUserData(t, 'mum', KEY, BASE);
    expect(t.services[1]).toEqual({
      id: 'premiumize',
      enabled: false,
      credentials: {},
    });
  });

  it('does not override addonName (manifest falls back to ADDON_NAME) and sets synthetic uuid + selfManifestUrl', () => {
    const userData = buildKevboxUserData(template(), 'mum', KEY, BASE);
    expect(userData.addonName).toBeUndefined();
    expect(userData.uuid).toBe(syntheticUuid('mum'));
    expect(userData.selfManifestUrl).toBe(
      `${BASE}/stremio/k/mum/${KEY}/manifest.json`
    );
  });

  it('injects the config access key when provided', () => {
    const userData = buildKevboxUserData(template(), 'mum', KEY, BASE, 'k3y');
    expect(userData.accessKey).toBe('k3y');
  });

  it('omits accessKey when not provided', () => {
    const userData = buildKevboxUserData(template(), 'mum', KEY, BASE, null);
    expect(userData.accessKey).toBeUndefined();
  });

  it('rejects invalid member names', () => {
    expect(() => buildKevboxUserData(template(), 'Mum!', KEY, BASE)).toThrow(
      KevboxParamError
    );
    expect(() =>
      buildKevboxUserData(template(), 'a'.repeat(65), KEY, BASE)
    ).toThrow(KevboxParamError);
  });

  it('accepts lowercase email local-parts as member names', () => {
    for (const name of ['kevin.chiha', 'alecco_999', 'member+tv']) {
      expect(() => buildKevboxUserData(template(), name, KEY, BASE)).not.toThrow();
    }
  });

  it('rejects malformed API keys', () => {
    expect(() => buildKevboxUserData(template(), 'mum', 'short', BASE)).toThrow(
      KevboxParamError
    );
    expect(() =>
      buildKevboxUserData(template(), 'mum', 'bad key with spaces', BASE)
    ).toThrow(KevboxParamError);
  });

  it('rejects a template without a premiumize service', () => {
    expect(() =>
      buildKevboxUserData({ presets: [], services: [] }, 'mum', KEY, BASE)
    ).toThrow(KevboxParamError);
  });
});
