/**
 * Browser runtime configuration: the subset of ServerConfig an embedding host may set, validated and
 * merged onto Node's defaults. Everything else is fixed, because the browser session replaces it
 * (URL, credentials, TLS) or v1 does not support it (plugins, SQLite cache, abapGit, stored text).
 * See docs/plans/2026-10-20-browser-embedded-runtime.md.
 */

import { canonicalDataSourceNames } from '../adt/data-source-name.js';
import { normalizeSystemLabel, validateConfig } from '../server/config.js';
import { validateDenyActions } from '../server/deny-actions.js';
import { DEFAULT_CONFIG, type ServerConfig } from '../server/types.js';

const BOOLEAN_KEYS = [
  'allowWrites',
  'allowDataPreview',
  'allowFreeSQL',
  'allowTransportWrites',
  'lintBeforeWrite',
  'checkBeforeWrite',
  'minimalErrors',
] as const satisfies readonly (keyof ServerConfig)[];

const STRING_LIST_KEYS = [
  'allowedPackages',
  'allowedTransports',
  'denyActions',
  'blockedDataSources',
] as const satisfies readonly (keyof ServerConfig)[];

const POSITIVE_INTEGER_KEYS = [
  'maxConcurrent',
  'maxDataPreviewResponseBytes',
  'maxConcurrentDataResults',
] as const satisfies readonly (keyof ServerConfig)[];

const TOGGLE = ['auto', 'on', 'off'] as const;
const ENUM_KEYS = {
  featureGcts: TOGGLE,
  featureRap: TOGGLE,
  featureAmdp: TOGGLE,
  featureUi5: TOGGLE,
  featureTransport: TOGGLE,
  featureHana: TOGGLE,
  featureUi5Repo: TOGGLE,
  featureFlp: TOGGLE,
  systemType: ['auto', 'btp', 'onprem'],
  toolMode: ['standard', 'hyperfocused'],
  schemaNullableOptionals: TOGGLE,
  cacheMode: ['memory', 'none'],
  logLevel: ['debug', 'info', 'warn', 'error'],
} as const satisfies Partial<Record<keyof ServerConfig, readonly string[]>>;

const STRING_KEYS = [
  'client',
  'language',
  'serverName',
  'systemLabel',
  'abapRelease',
] as const satisfies readonly (keyof ServerConfig)[];

const SUPPORTED_KEYS = [
  ...BOOLEAN_KEYS,
  ...STRING_LIST_KEYS,
  ...POSITIVE_INTEGER_KEYS,
  ...Object.keys(ENUM_KEYS),
  ...STRING_KEYS,
].sort();

type BooleanKey = (typeof BOOLEAN_KEYS)[number];
type StringListKey = (typeof STRING_LIST_KEYS)[number];
type PositiveIntegerKey = (typeof POSITIVE_INTEGER_KEYS)[number];
type EnumKey = keyof typeof ENUM_KEYS;
type StringKey = (typeof STRING_KEYS)[number];

/** Settings the embedding host may supply; omitted ones keep the browser defaults. */
export type BrowserServerConfig = Pick<ServerConfig, BooleanKey | StringListKey | PositiveIntegerKey | StringKey> & {
  [K in EnumKey]: (typeof ENUM_KEYS)[K][number];
};

/** Actions v1 never serves, whatever the host configures: stored text needs inflate's consumed-byte count. */
export const BROWSER_DENIED_ACTIONS: readonly string[] = ['SAPQuery.long_text'];

/** ABAP user names (XUBNAME) are at most 12 characters. */
const MAX_USER_LENGTH = 12;

/**
 * Browser defaults: Node's safe defaults (read-only, `$TMP` only, no data or SQL), plus no `sap-client`
 * parameter (the browser session already belongs to one client), memory cache and no abapGit.
 */
export const BROWSER_DEFAULT_CONFIG: Readonly<ServerConfig> = Object.freeze({
  ...DEFAULT_CONFIG,
  client: '',
  featureAbapGit: 'off',
  cacheMode: 'memory',
});

function fail(key: string, expected: string): never {
  throw new Error(`Browser config '${key}' must be ${expected}.`);
}

function readStringList(key: StringListKey, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    fail(key, 'an array of non-empty strings');
  }
  return value.map((entry: string) => entry.trim());
}

function readPositiveInteger(key: PositiveIntegerKey, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(key, 'a positive integer');
  return value as number;
}

/** Normalize the host-supplied SAP user, used for `adtcore:responsible` and `SAPRead SYSTEM`. */
export function normalizeBrowserUser(user: unknown): string {
  if (user === undefined) return '';
  if (typeof user !== 'string') fail('user', 'a string');
  const normalized = user.trim().toUpperCase();
  if (normalized.length > MAX_USER_LENGTH || /\s/.test(normalized)) {
    fail('user', `an SAP user name of at most ${MAX_USER_LENGTH} characters without spaces`);
  }
  return normalized;
}

/**
 * Validate host settings and merge them onto the browser defaults. Unknown keys fail, so a setting
 * the browser runtime cannot honor (a URL, credentials, plugins, ...) is never silently ignored.
 */
export function resolveBrowserConfig(input: Partial<BrowserServerConfig> = {}, user?: string): ServerConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('config', 'an object');
  const config: ServerConfig = { ...BROWSER_DEFAULT_CONFIG, username: normalizeBrowserUser(user) };
  const writable = config as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') fail(key, 'true or false');
      writable[key] = value;
    } else if ((STRING_LIST_KEYS as readonly string[]).includes(key)) {
      writable[key] = readStringList(key as StringListKey, value);
    } else if ((POSITIVE_INTEGER_KEYS as readonly string[]).includes(key)) {
      writable[key] = readPositiveInteger(key as PositiveIntegerKey, value);
    } else if (key in ENUM_KEYS) {
      const allowed: readonly string[] = ENUM_KEYS[key as EnumKey];
      if (typeof value !== 'string' || !allowed.includes(value)) fail(key, `one of ${allowed.join(', ')}`);
      writable[key] = value;
    } else if ((STRING_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'string') fail(key, 'a string');
      writable[key] = value.trim();
    } else {
      throw new Error(`Browser config '${key}' is not supported. Supported: ${SUPPORTED_KEYS.join(', ')}.`);
    }
  }

  // An empty list means "every package" to the safety check; require that to be explicit.
  if (config.allowedPackages.length === 0) fail('allowedPackages', "non-empty (use ['*'] to allow every package)");
  config.systemLabel = normalizeSystemLabel(config.systemLabel);
  config.blockedDataSources = canonicalDataSourceNames(config.blockedDataSources, 'blockedDataSources entry');
  validateDenyActions(config.denyActions);
  config.denyActions = [...new Set([...config.denyActions, ...BROWSER_DENIED_ACTIONS])];
  validateConfig(config);
  return config;
}
