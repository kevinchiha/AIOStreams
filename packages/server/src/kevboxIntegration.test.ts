import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(serverDir, 'dist/server.js');
const fixture = path.join(serverDir, 'test-fixtures/kevbox.fixture.json');
const built = existsSync(serverEntry);

const PORT = 3899;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'dummykey12345';

let child: ChildProcess | undefined;

const waitForHealth = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not become healthy within 30s');
};

describe.skipIf(!built)('kevbox routes (built server)', () => {
  beforeAll(async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'kevbox-int-'));
    child = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(PORT),
        BASE_URL: BASE,
        SECRET_KEY: '0'.repeat(64),
        DATABASE_URI: `sqlite://${path.join(dataDir, 'db.sqlite')}`,
        KEVBOX_MEMBERS: 'mum,kevin',
        KEVBOX_TEMPLATE_PATH: fixture,
      },
      stdio: 'ignore',
    });
    await waitForHealth();
  }, 60_000);

  afterAll(() => {
    child?.kill();
  });

  it('serves a member-branded manifest', async () => {
    const res = await fetch(`${BASE}/stremio/k/mum/${KEY}/manifest.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name?: string };
    expect(body.name).toBe('Kevbox (Mum)');
  });

  it('rejects a non-allowlisted member with a playable error stream, not a 500', async () => {
    const res = await fetch(
      `${BASE}/stremio/k/stranger/${KEY}/stream/movie/tt0111161.json`
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('not an allowed kevbox member');
  });

  it('rejects a malformed API key with a playable error stream', async () => {
    const res = await fetch(
      `${BASE}/stremio/k/mum/short/stream/movie/tt0111161.json`
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Invalid Premiumize API key');
  });

  it('rejects a non-allowlisted member on manifest.json with an API error', async () => {
    const res = await fetch(`${BASE}/stremio/k/stranger/${KEY}/manifest.json`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('redirects /configure to the public configure page', async () => {
    const res = await fetch(`${BASE}/stremio/k/mum/${KEY}/configure`, {
      redirect: 'manual',
    });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('location')).toBe('/stremio/configure');
  });
});
