import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKevboxTemplate, loadKevboxTemplate } from './kevboxTemplate.js';

// repo root relative to packages/server/src/utils/
const repoTemplate = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../kevbox.config.json'
);

const dummyEnv = {
  KEVBOX_MEDIAFLOW_URL: 'https://mediaflow.example.com',
  KEVBOX_MEDIAFLOW_PASSWORD: 'dummy-password',
  KEVBOX_RPDB_KEY: 'dummy-rpdb-key',
  KEVBOX_MEDIAFUSION_URL: 'https://mediafusion.example.com',
};

interface TemplatePreset {
  type: string;
  instanceId: string;
  enabled: boolean;
  options: Record<string, unknown> & { services?: string[] };
}

interface TemplateCatalogModification {
  addonName: string;
}

function presets(template: Record<string, unknown>): TemplatePreset[] {
  return template.presets as TemplatePreset[];
}

describe('repo kevbox.config.json', () => {
  it('passes the boot check with all placeholders substituted', () => {
    expect(checkKevboxTemplate(repoTemplate, dummyEnv)).toEqual({ ok: true });
  });

  it('has torrentio as the first preset, wired to premiumize', () => {
    const all = presets(loadKevboxTemplate(repoTemplate, dummyEnv));
    expect(all[0].type).toBe('torrentio');
    expect(all[0].enabled).toBe(true);
    expect(all[0].options.services).toEqual(['premiumize']);
  });

  it('contains no unsubstituted placeholders after load', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    expect(JSON.stringify(template)).not.toContain('${');
  });

  it('carries no stale export artifacts', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    expect(template.trusted).toBeUndefined();
    expect(JSON.stringify(template)).not.toContain('fankai');
  });

  it('has exactly the agreed sourcing lineup, all enabled on premiumize', () => {
    const all = presets(loadKevboxTemplate(repoTemplate, dummyEnv));
    expect(all.map((p) => p.type).sort()).toEqual(
      [
        'mediafusion',
        'peerflix',
        'prowlarr',
        'stremthruTorz',
        'torrentio',
        'torrents-db',
        'zilean',
      ].sort()
    );
    for (const preset of all) {
      expect(preset.enabled, `${preset.type} should be enabled`).toBe(true);
      expect(
        preset.options.services,
        `${preset.type} should use premiumize`
      ).toEqual(['premiumize']);
    }
  });

  it('prowlarr preset relies on the preconfigured builtin instance (no url/key in template)', () => {
    const prowlarr = presets(loadKevboxTemplate(repoTemplate, dummyEnv)).find(
      (p) => p.type === 'prowlarr'
    );
    expect(prowlarr).toBeDefined();
    expect(prowlarr?.options.prowlarrUrl).toBeUndefined();
    expect(prowlarr?.options.prowlarrApiKey).toBeUndefined();
    expect(prowlarr?.options.sources).toEqual(['torrent']);
  });

  it('mediafusion points at the self-hosted instance via env placeholder', () => {
    const mediafusion = presets(loadKevboxTemplate(repoTemplate, dummyEnv)).find(
      (p) => p.type === 'mediafusion'
    );
    expect(mediafusion?.options.url).toBe('https://mediafusion.example.com');
    expect(mediafusion?.options.useCachedResultsOnly).toBe(true);
    expect(mediafusion?.options.resources).toEqual(['stream']);
  });

  it('service-wraps mediafusion through premiumize (MF v6 returns raw infoHashes)', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    expect(template.serviceWrap).toEqual({
      enabled: true,
      presets: ['a04'],
      services: ['premiumize'],
    });
  });

  it('carries no catalog modifications for dropped addons', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    const mods = template.catalogModifications as TemplateCatalogModification[];
    const addonNames = mods.map((m) => m.addonName);
    expect(addonNames).not.toContain('Sootio');
    expect(addonNames).not.toContain('Comet');
    expect(addonNames.sort()).toEqual(['Peerflix', 'TorrentsDB']);
  });
});
