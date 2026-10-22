/**
 * ARC-1 browser runtime (`arc-1/browser`, @experimental): an MCP server for a Web Worker served from the
 * ABAP system's origin. ADT calls are same-origin fetches on the user's own SAP session; the embedding
 * host supplies settings, the SAP user name and audit sinks.
 * See docs/plans/2026-10-20-browser-embedded-runtime.md.
 */

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AdtClient } from '../adt/client.js';
import { defaultFeatureConfig, type FeatureMode } from '../adt/config.js';
import { probeFeatures } from '../adt/features.js';
import { AdtHttpClient } from '../adt/http.js';
import { shouldWarnPreStatefulRelease } from '../adt/release.js';
import type { SafetyConfig } from '../adt/safety.js';
import { Semaphore } from '../adt/semaphore.js';
import { CachingLayer } from '../cache/caching-layer.js';
import { MemoryCache } from '../cache/memory.js';
import { handleToolCall } from '../handlers/dispatch.js';
import {
  cacheProbedFeatures,
  getCachedDiscovery,
  getCachedFeatures,
  setCachedDiscovery,
} from '../handlers/feature-cache.js';
import { createQueryDefinition } from '../handlers/query-tool.js';
import { getToolDefinitions, type ToolDefinition } from '../handlers/tools.js';
import { generateRequestId } from '../server/context.js';
import { initLogger, logger } from '../server/logger.js';
import { buildServerInstructions } from '../server/server-instructions.js';
import type { LogSink } from '../server/sinks/types.js';
import { filterToolsByAuthScope } from '../server/tool-auth.js';
import type { ServerConfig } from '../server/types.js';
import { VERSION } from '../version.js';
import { type BrowserServerConfig, resolveBrowserConfig } from './config.js';

export type { LogSink } from '../server/sinks/types.js';
export type { BrowserServerConfig } from './config.js';
export { type MessagePortLike, MessagePortTransport } from './message-port-transport.js';

/** Contract version of this entry point; bumped on any breaking change while @experimental. */
export const BROWSER_API_VERSION = 1;

export interface BrowserServerOptions {
  /** Same-origin fetch on the user's SAP session. Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Origin of the ABAP system. Default: `globalThis.location.origin` (the worker's own origin). */
  baseUrl?: string;
  /** Host settings; omitted ones keep the safe defaults (read-only, `$TMP` only, no data or SQL). */
  config?: Partial<BrowserServerConfig>;
  /**
   * The logged-on SAP user, which the browser cannot read from its session. Used as `adtcore:responsible`
   * on create and shown by `SAPRead SYSTEM`; never used for authentication. Recorded in audit events.
   */
  user?: string;
  /** Audit sinks in addition to the console. */
  sinks?: LogSink[];
}

export interface BrowserServer {
  readonly server: Server;
  /** The resolved configuration (host settings merged onto browser defaults). */
  readonly config: Readonly<ServerConfig>;
  /** Connect the MCP transport, then probe the system's features and announce the narrowed tool list. */
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** Every scope: the configured safety ceiling is the only gate, as on stdio. */
const BROWSER_SCOPES = ['admin'];

function safetyFromConfig(config: ServerConfig): SafetyConfig {
  return {
    allowWrites: config.allowWrites,
    allowDataPreview: config.allowDataPreview,
    allowFreeSQL: config.allowFreeSQL,
    allowTransportWrites: config.allowTransportWrites,
    allowGitWrites: config.allowGitWrites,
    blockedDataSources: [...config.blockedDataSources],
    allowedPackages: [...config.allowedPackages],
    allowedTransports: [...config.allowedTransports],
    denyActions: [...config.denyActions],
  };
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  const origin = baseUrl ?? (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) throw new Error('createBrowserServer needs baseUrl outside a browser context.');
  return origin;
}

/** Create the client the browser runtime dispatches through: browser transport, host user, config ceiling. */
export function createBrowserClient(config: ServerConfig, fetchImpl: typeof fetch, baseUrl: string): AdtClient {
  const http = new AdtHttpClient({
    baseUrl,
    client: config.client,
    language: config.language,
    browserFetch: fetchImpl,
    semaphore: new Semaphore(config.maxConcurrent),
  });
  return new AdtClient({
    http,
    username: config.username,
    client: config.client,
    language: config.language,
    safety: safetyFromConfig(config),
    maxDataPreviewResponseBytes: config.maxDataPreviewResponseBytes,
    maxConcurrentDataResults: config.maxConcurrentDataResults,
  });
}

async function probeBrowserFeatures(config: ServerConfig, client: AdtClient): Promise<void> {
  const featureConfig = defaultFeatureConfig();
  featureConfig.hana = config.featureHana as FeatureMode;
  featureConfig.abapGit = config.featureAbapGit as FeatureMode;
  featureConfig.gcts = config.featureGcts as FeatureMode;
  featureConfig.rap = config.featureRap as FeatureMode;
  featureConfig.amdp = config.featureAmdp as FeatureMode;
  featureConfig.ui5 = config.featureUi5 as FeatureMode;
  featureConfig.transport = config.featureTransport as FeatureMode;
  featureConfig.ui5repo = config.featureUi5Repo as FeatureMode;
  featureConfig.flp = config.featureFlp as FeatureMode;
  const features = await probeFeatures(client.http, featureConfig, config.systemType);
  cacheProbedFeatures(features, false);
  setCachedDiscovery(getCachedFeatures()?.discoveryMap ?? new Map());
  if (shouldWarnPreStatefulRelease(config.allowWrites, features.abapRelease)) {
    logger.warn(
      `SAP_BASIS ${features.abapRelease} is below 7.51: object writes fail with 423 "invalid lock handle" ` +
        'unless the abapfs_extensions enhancement is installed on the SAP system.',
    );
  }
}

/** The tool list for a configuration and the features known so far (all features until the probe ends). */
export function browserToolDefinitions(config: ServerConfig): ToolDefinition[] {
  const features = getCachedFeatures();
  const tools = getToolDefinitions(config, features?.textSearch?.available, features, {
    nullableOptionals: config.schemaNullableOptionals === 'on',
    discoveryMap: getCachedDiscovery(),
  });
  return filterToolsByAuthScope(tools, BROWSER_SCOPES, config.denyActions, createQueryDefinition(config, features));
}

/**
 * Create the browser MCP server. One per worker: the logger, feature cache and request context are
 * module-level, and tool calls run one at a time (the request-context stand-in requires it).
 */
export function createBrowserServer(options: BrowserServerOptions = {}): BrowserServer {
  const config = Object.freeze(resolveBrowserConfig(options.config, options.user));
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const client = createBrowserClient(config, fetchImpl, resolveBaseUrl(options.baseUrl));
  const cachingLayer = config.cacheMode === 'none' ? undefined : new CachingLayer(new MemoryCache(), 0);

  initLogger(config.logFormat, config.logLevel);
  for (const sink of options.sinks ?? []) logger.addSink(sink);

  const authInfo: AuthInfo = {
    token: '',
    clientId: 'arc-1-browser',
    scopes: BROWSER_SCOPES,
    ...(config.username ? { extra: { userName: config.username } } : {}),
  };

  const server = new Server(
    { name: config.serverName, version: VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: buildServerInstructions(config.systemLabel) },
  );

  // Tool calls and the feature probe run one at a time, in arrival order.
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };

  // Like Node, never wait for the probe here: answer with what is known and announce the narrowed list later.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: browserToolDefinitions(config) }));

  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    serialize(async () => {
      client.http.setDiscoveryMap(getCachedDiscovery());
      const result = await handleToolCall(
        client,
        config,
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        authInfo,
        server,
        cachingLayer,
        false,
        undefined,
        generateRequestId(),
        undefined,
        extra.signal,
      );
      return { ...result } as Record<string, unknown>;
    }),
  );

  const initialized = new Promise<void>((resolve) => {
    server.oninitialized = resolve;
  });

  return {
    server,
    config,
    async connect(transport) {
      await server.connect(transport);
      const probed = serialize(() => probeBrowserFeatures(config, client)).then(
        () => true,
        (err: unknown) => {
          // Unknown features keep the full tool list; each call still meets SAP's own checks.
          setCachedDiscovery(new Map());
          logger.warn('Feature probe failed; serving the unprobed tool list', {
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        },
      );
      // Notifications may only follow the client's initialization.
      void Promise.all([probed, initialized])
        .then(([narrowed]) => (narrowed ? server.sendToolListChanged() : undefined))
        .catch(() => undefined);
    },
    close: () => server.close(),
  };
}
