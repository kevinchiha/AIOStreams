import { existsSync, readFileSync, statSync } from 'node:fs';

const PLACEHOLDER_REGEX = /\$\{([A-Z][A-Z0-9_]*)\}/g;

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
