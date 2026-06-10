import { createHash } from 'node:crypto';
import type { UserData } from '@aiostreams/core';

// Supports both legacy short names and the lowercase local-part of a member email.
export const KEVBOX_NAME_REGEX = /^[a-z0-9._+-]{1,64}$/;
export const KEVBOX_API_KEY_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

/** Invalid member name / API key — maps to a user-facing error, not a 500. */
export class KevboxParamError extends Error {}

/**
 * Deterministic UUIDv5-format id derived from the member name, so a member's
 * identity is stable across Premiumize key rotations. Safe to share per name
 * because the KEVBOX_MEMBERS allowlist (middleware) is the only way in.
 */
export function syntheticUuid(name: string): string {
  const digest = createHash('sha1').update(`kevbox.dev:${name}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function memberDisplayName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Build a per-member UserData from the kevbox template: validate URL params,
 * inject the Premiumize key, the operator config-access key (when the auth
 * gate is active) and member identity. Never mutates the (cached) template.
 */
export function buildKevboxUserData(
  template: Record<string, unknown>,
  name: string,
  apiKey: string,
  baseUrl: string,
  accessKey?: string | null
): UserData {
  if (!KEVBOX_NAME_REGEX.test(name)) {
    throw new KevboxParamError(
      `Invalid kevbox member name "${name}" — expected 1-64 chars of a-z, 0-9, ".", "_", "+" or "-"`
    );
  }
  if (!KEVBOX_API_KEY_REGEX.test(apiKey)) {
    throw new KevboxParamError('Invalid Premiumize API key format');
  }

  const cloned = structuredClone(template) as UserData;
  const services = (cloned.services ?? []).map((service) =>
    service.id === 'premiumize'
      ? {
          ...service,
          enabled: true,
          credentials: { ...service.credentials, apiKey },
        }
      : service
  );
  if (!services.some((service) => service.id === 'premiumize')) {
    throw new KevboxParamError(
      'kevbox template has no premiumize service entry'
    );
  }

  return {
    ...cloned,
    services,
    uuid: syntheticUuid(name),
    // No addonName override: the manifest falls back to ADDON_NAME ("Kevbox"),
    // so every member's addon just shows "Kevbox" (no per-member suffix).
    selfManifestUrl: `${baseUrl}/stremio/k/${name}/${apiKey}/manifest.json`,
    ...(accessKey ? { accessKey } : {}),
  };
}
