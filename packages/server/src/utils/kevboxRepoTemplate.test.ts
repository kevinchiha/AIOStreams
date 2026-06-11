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

  it('does not include the dropped mediafusion preset or a serviceWrap block', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    const all = presets(template);
    expect(all.find((p) => p.type === 'mediafusion')).toBeUndefined();
    expect(all.find((p) => p.instanceId === 'a04')).toBeUndefined();
    expect(template.serviceWrap).toBeUndefined();
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
