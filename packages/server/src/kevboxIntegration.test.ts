import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(serverDir, 'dist/server.js');
const fixture = path.join(serverDir, 'test-fixtures/kevbox.fixture.json');
const badFixture = path.join(
  serverDir,
  'test-fixtures/kevbox.badservice.fixture.json'
);
// The real shipped template, two dirs up from packages/server.
const repoTemplate = path.resolve(serverDir, '../../kevbox.config.json');
const built = existsSync(serverEntry);

const PORT = 3899;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'dummykey12345';

// Placeholder secrets so the real template's ${KEVBOX_*} vars resolve at load.
const DUMMY_KEVBOX_ENV = {
  KEVBOX_MEDIAFLOW_URL: 'https://mediaflow.example.com',
  KEVBOX_MEDIAFLOW_PASSWORD: 'dummy',
  KEVBOX_RPDB_KEY: 'dummy',
};

let child: ChildProcess | undefined;

const waitForHealth = async (base: string): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/api/v1/health`);
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
    await waitForHealth(BASE);
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

  // Mount-parity guard: every resource the kevbox router mirrors from
  // stremioAuthRouter must be reachable (a missing mount falls through to a
  // routing 404). Probes the four resources the cases above do not, so a
  // dropped kevbox.ts mount is caught here, not by a silent family 404.
  it('mounts all six stremio resources (none falls through to a 404)', async () => {
    const paths = [
      `/stremio/k/mum/${KEY}/manifest.json`,
      `/stremio/k/mum/${KEY}/stream/movie/tt0111161.json`,
      `/stremio/k/mum/${KEY}/meta/movie/tt0111161.json`,
      `/stremio/k/mum/${KEY}/catalog/movie/top.json`,
      `/stremio/k/mum/${KEY}/subtitles/movie/tt0111161.json`,
      `/stremio/k/mum/${KEY}/addon_catalog/movie/top.json`,
    ];
    for (const p of paths) {
      const res = await fetch(`${BASE}${p}`);
      expect(res.status, `${p} should be mounted (not 404)`).not.toBe(404);
    }
  });
});

// Guards the SHIPPED template against service/preset schema drift between the
// export's source instance and this fork's UserDataSchema (the bug that shipped
// a `debridge` service id this build did not know). If kevbox.config.json ever
// drifts, the strengthened boot check fails and the server never goes healthy.
const REAL_PORT = 3898;
const REAL_BASE = `http://127.0.0.1:${REAL_PORT}`;
let realChild: ChildProcess | undefined;

describe.skipIf(!built)('kevbox real template (schema-drift guard)', () => {
  beforeAll(async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'kevbox-real-'));
    realChild = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        ...DUMMY_KEVBOX_ENV,
        NODE_ENV: 'test',
        PORT: String(REAL_PORT),
        BASE_URL: REAL_BASE,
        SECRET_KEY: '0'.repeat(64),
        DATABASE_URI: `sqlite://${path.join(dataDir, 'db.sqlite')}`,
        KEVBOX_MEMBERS: 'kevin',
        KEVBOX_TEMPLATE_PATH: repoTemplate,
      },
      stdio: 'ignore',
    });
    await waitForHealth(REAL_BASE);
  }, 60_000);

  afterAll(() => {
    realChild?.kill();
  });

  it('boots — the shipped kevbox.config.json passes the boot schema check', async () => {
    const res = await fetch(`${REAL_BASE}/api/v1/health`);
    expect(res.ok).toBe(true);
  });
});

// Proves the strengthened boot check actually REJECTS a schema-invalid template
// (here a service id this build does not recognise) by failing the deploy at
// boot, rather than passing boot and 400-ing every family request.
describe.skipIf(!built)('kevbox boot rejects a schema-invalid template', () => {
  it('exits non-zero with a kevbox schema-validation error', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'kevbox-bad-'));
    const proc = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        ...DUMMY_KEVBOX_ENV,
        NODE_ENV: 'test',
        PORT: '3897',
        BASE_URL: 'http://127.0.0.1:3897',
        SECRET_KEY: '0'.repeat(64),
        DATABASE_URI: `sqlite://${path.join(dataDir, 'db.sqlite')}`,
        KEVBOX_MEMBERS: 'kevin',
        KEVBOX_TEMPLATE_PATH: badFixture,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout?.on('data', (d) => (output += String(d)));
    proc.stderr?.on('data', (d) => (output += String(d)));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, 30_000);
      proc.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).not.toBe(0);
    expect(output).toMatch(
      /kevbox template (fails schema validation|boot validation failed|check failed)/
    );
  }, 40_000);
});
