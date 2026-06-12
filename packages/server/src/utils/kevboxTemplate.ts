import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PLACEHOLDER_REGEX = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/** Resolved path to the kevbox template (env override, else <cwd>/kevbox.config.json). */
export function kevboxTemplatePath(): string {
  return (
    process.env.KEVBOX_TEMPLATE_PATH ??
    path.resolve(process.cwd(), 'kevbox.config.json')
  );
}

/** Member name rule (mirrors the AIOStreams allowlist + kevbox-admin). */
const KEVBOX_NAME_REGEX = /^[a-z0-9._+-]{1,64}$/;

interface MembersFileEntry {
  mtimeMs: number;
  size: number;
  names: string[];
}
/** mtime+size cache, keyed by file path (mirrors loadKevboxTemplate's cache). */
const membersFileCache = new Map<string, MembersFileEntry>();

/**
 * Resolve the allowlist from KEVBOX_MEMBERS_FILE, or null to signal "no usable file"
 * (caller then falls back to KEVBOX_MEMBERS env). A present file is "usable" only if it
 * parses to a NON-EMPTY array of names; missing / 0-byte / whitespace / malformed / `[]`
 * all return null so the file source can never by itself disable kevbox (spec §7, C3).
 * Parse errors are caught + logged, never thrown into the request/boot path.
 */
function kevboxMembersFromFile(env: NodeJS.ProcessEnv): string[] | null {
  const filePath = env.KEVBOX_MEMBERS_FILE;
  if (!filePath || !existsSync(filePath)) return null;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  const cached = membersFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.names.length > 0 ? cached.names : null;
  }
  let names: string[];
  try {
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (raw === '') return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    names = parsed
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.trim())
      .filter((n) => {
        if (KEVBOX_NAME_REGEX.test(n)) return true;
        // eslint-disable-next-line no-console
        console.warn(`kevbox: dropping invalid members.json entry "${n}"`);
        return false;
      });
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.warn(
      `kevbox: members.json at ${filePath} unreadable/not-JSON, falling back to env: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
  membersFileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, names });
  return names.length > 0 ? names : null;
}

/**
 * The member allowlist. Resolution precedence (spec §7): a usable members.json file
 * (KEVBOX_MEMBERS_FILE → non-empty array) wins; otherwise fall back to KEVBOX_MEMBERS
 * (comma-separated, trimmed, blanks dropped). Empty resolved array = kevbox disabled.
 * Kept core-free so it is unit-testable without booting the @aiostreams/core env.
 */
export function kevboxMembers(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromFile = kevboxMembersFromFile(env);
  if (fromFile) return fromFile;
  return (env.KEVBOX_MEMBERS ?? '')
    .split(',')
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
}

/**
 * Replace ${ENV_VAR} placeholders with JSON-escaped env values.
 * Throws listing every missing/empty variable so a misconfigured
 * deployment fails with one complete, actionable message.
 */
export function substituteEnvPlaceholders(
  raw: string,
  env: NodeJS.ProcessEnv
): string {
  const missing = new Set<string>();
  const result = raw.replace(PLACEHOLDER_REGEX, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing.add(name);
      return '';
    }
    // JSON-escape so quotes/backslashes in secrets cannot corrupt the document
    return JSON.stringify(value).slice(1, -1);
  });
  if (missing.size > 0) {
    throw new Error(
      `kevbox template references unset environment variables: ${[...missing].join(', ')}`
    );
  }
  return result;
}

interface CacheEntry {
  mtimeMs: number;
  template: Record<string, unknown>;
}

const cache = new Map<string, CacheEntry>();

/**
 * Load, substitute and parse the kevbox template, cached by file mtime.
 * Env values are assumed static for the process lifetime (substitution
 * is part of the cached result).
 */
export function loadKevboxTemplate(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const { mtimeMs } = statSync(filePath);
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.template;
  }
  const raw = readFileSync(filePath, 'utf-8');
  const substituted = substituteEnvPlaceholders(raw, env);
  let template: Record<string, unknown>;
  try {
    template = JSON.parse(substituted) as Record<string, unknown>;
  } catch (error: unknown) {
    throw new Error(
      `kevbox template at ${filePath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  cache.set(filePath, { mtimeMs, template });
  return template;
}

export type KevboxTemplateCheck = { ok: true } | { ok: false; reason: string };

/**
 * Boot-time structural check: file exists, placeholders resolve, JSON parses,
 * and the template has presets plus a premiumize service entry. Full schema
 * validation happens per-request via validateConfig.
 */
export function checkKevboxTemplate(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env
): KevboxTemplateCheck {
  if (!existsSync(filePath)) {
    return { ok: false, reason: `template file not found at ${filePath}` };
  }
  try {
    const template = loadKevboxTemplate(filePath, env);
    const services = template.services;
    const hasPremiumize =
      Array.isArray(services) &&
      services.some(
        (service) =>
          typeof service === 'object' &&
          service !== null &&
          (service as { id?: unknown }).id === 'premiumize'
      );
    if (!hasPremiumize) {
      return { ok: false, reason: 'template has no premiumize service entry' };
    }
    if (!Array.isArray(template.presets) || template.presets.length === 0) {
      return { ok: false, reason: 'template has no presets' };
    }
    // Mirror validateConfig's two hard (non-schema, never-skipped) preset
    // checks offline, so a duplicate/dotted instanceId fails the deploy at
    // boot instead of 400-ing every family request (UserDataSchema.safeParse
    // alone does not catch these — see the boot probe in server.ts).
    const seenInstanceIds = new Set<string>();
    for (const preset of template.presets) {
      const id =
        typeof preset === 'object' && preset !== null
          ? (preset as { instanceId?: unknown }).instanceId
          : undefined;
      if (typeof id !== 'string') continue;
      if (id.includes('.')) {
        return { ok: false, reason: `preset instanceId "${id}" must not contain "."` };
      }
      if (seenInstanceIds.has(id)) {
        return { ok: false, reason: `duplicate preset instanceId "${id}"` };
      }
      seenInstanceIds.add(id);
    }
    return { ok: true };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
