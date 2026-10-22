/**
 * Snapshots of the browser runtime's LLM-visible tool surface (see tool-definitions-snapshot.test.ts).
 * To change it intentionally, run vitest with -u and review the fixture diff.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserServerConfig } from '../../../src/browser/config.js';
import { resolveBrowserConfig } from '../../../src/browser/config.js';
import { browserToolDefinitions } from '../../../src/browser/index.js';
import { resetCachedFeatures, setCachedFeatures } from '../../../src/handlers/feature-cache.js';
import { features } from '../handlers/handler-test-config.js';

const VARIANTS: Array<{ name: string; config: Partial<BrowserServerConfig> }> = [
  { name: 'browser-readonly', config: { systemType: 'onprem' } },
  {
    name: 'browser-full',
    config: {
      systemType: 'onprem',
      allowWrites: true,
      allowTransportWrites: true,
      allowDataPreview: true,
      allowFreeSQL: true,
      allowedPackages: ['Z*'],
    },
  },
];

describe('browser tool-definitions snapshot', () => {
  afterEach(() => resetCachedFeatures());

  for (const variant of VARIANTS) {
    it(`is stable: ${variant.name}`, async () => {
      // abapGit is off in the browser, so the probe never reports it available.
      setCachedFeatures(features({ abapGit: false }));
      const tools = browserToolDefinitions(resolveBrowserConfig(variant.config));
      await expect(JSON.stringify(tools, null, 2)).toMatchFileSnapshot(
        `../../fixtures/tool-definitions/${variant.name}.json`,
      );
    });
  }
});
