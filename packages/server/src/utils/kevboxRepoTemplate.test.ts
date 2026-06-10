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

describe('repo kevbox.config.json', () => {
  it('passes the boot check with all placeholders substituted', () => {
    expect(checkKevboxTemplate(repoTemplate, dummyEnv)).toEqual({ ok: true });
  });

  it('has torrentio as the first preset, wired to premiumize', () => {
    const template = loadKevboxTemplate(repoTemplate, dummyEnv);
    const presets = template.presets as Array<{
      type: string;
      enabled: boolean;
      options: { services: string[] };
    }>;
    expect(presets[0].type).toBe('torrentio');
    expect(presets[0].enabled).toBe(true);
    expect(presets[0].options.services).toEqual(['premiumize']);
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
});
