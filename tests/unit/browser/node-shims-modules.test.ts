import * as nodeCrypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { process as browserProcess } from '../../../src/browser/globals.js';
import { createHash } from '../../../src/browser/node-shims/crypto.js';
import { readFileSync as shimReadFileSync } from '../../../src/browser/node-shims/fs.js';
import { isIP } from '../../../src/browser/node-shims/net.js';
import { homedir } from '../../../src/browser/node-shims/os.js';
import { dirname, join, resolve } from '../../../src/browser/node-shims/path.js';
import { EMBEDDED_ASSETS, getAsset, isSea } from '../../../src/browser/node-shims/sea.js';
import { Agent, Client, fetch, getGlobalDispatcher } from '../../../src/browser/node-shims/undici.js';
import { fileURLToPath } from '../../../src/browser/node-shims/url.js';
import { promisify } from '../../../src/browser/node-shims/util.js';
import { gzipSync, inflateRaw } from '../../../src/browser/node-shims/zlib.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('node:sea browser stand-in (AFF schemas embedded in the bundle)', () => {
  const schemaFiles = readdirSync('src/aff/schemas').filter((file) => file.endsWith('.json'));

  it('embeds every schema in src/aff/schemas', () => {
    // A missing schema would make the validator skip validation for that type without an error.
    expect(Object.keys(EMBEDDED_ASSETS).sort()).toEqual(schemaFiles.map((file) => `aff/${file}`).sort());
  });

  it('serves each schema as the file content', () => {
    expect(isSea()).toBe(true);
    for (const file of schemaFiles) {
      expect(JSON.parse(getAsset(`aff/${file}`, 'utf8'))).toEqual(
        JSON.parse(readFileSync(`src/aff/schemas/${file}`, 'utf8')),
      );
    }
  });

  it('refuses unknown assets and encodings', () => {
    expect(() => getAsset('aff/unknown-v1.json', 'utf8')).toThrow(/no embedded asset/);
    expect(() => getAsset('aff/clas-v1.json')).toThrow(/encoding/);
  });
});

describe('node:url and node:path browser stand-ins', () => {
  it('derives a path from file, http(s) or missing module URLs without throwing', () => {
    expect(fileURLToPath('file:///app/dist/aff/validator.js')).toBe('/app/dist/aff/validator.js');
    expect(fileURLToPath('https://sap.example.com/ui/arc1%20worker.js')).toBe('/ui/arc1 worker.js');
    expect(fileURLToPath(undefined)).toBe('');
  });

  it('implements POSIX dirname and join', () => {
    expect(dirname('/app/dist/aff/validator.js')).toBe('/app/dist/aff');
    expect(dirname('/validator.js')).toBe('/');
    expect(dirname('validator.js')).toBe('.');
    expect(dirname('')).toBe('.');
    expect(join('/app/dist/aff', 'schemas', 'clas-v1.json')).toBe('/app/dist/aff/schemas/clas-v1.json');
    expect(join('', 'schemas', 'clas-v1.json')).toBe('schemas/clas-v1.json');
    expect(() => resolve()).toThrow(/resolve\(\) is not supported/);
  });
});

describe('node:crypto stand-in for dependencies', () => {
  it('matches Node sha1 for abaplint downport', () => {
    for (const text of ['', 'ZCL_DOWNPORT', 'Grüße 日本語']) {
      expect(createHash('sha1').update(text).digest('hex')).toBe(
        nodeCrypto.createHash('sha1').update(text).digest('hex'),
      );
    }
  });
});

describe('bundle-only stand-ins for unreachable Node paths', () => {
  it('throw when called', async () => {
    expect(() => shimReadFileSync()).toThrow(/node:fs browser shim/);
    expect(() => homedir()).toThrow(/node:os browser shim/);
    expect(() => gzipSync()).toThrow(/gzipDataPreviewBody/);
    expect(() => inflateRaw()).toThrow(/stored text/);
    expect(() => isIP()).toThrow(/abapGit/);
    expect(() => new Agent()).toThrow(/undici browser shim/);
    expect(() => new Client()).toThrow(/undici browser shim/);
    expect(() => fetch()).toThrow(/undici browser shim/);
    expect(() => getGlobalDispatcher()).toThrow(/undici browser shim/);
  });

  it('let promisify run at module load and reject on call', async () => {
    const inflate = promisify(function inflateRaw() {});
    await expect(inflate()).rejects.toThrow(/promisified inflateRaw\(\) is not supported/);
  });
});

describe('injected process global', () => {
  it('has empty env and routes stderr to console.error without the trailing newline', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(browserProcess.env).toEqual({});
    expect(browserProcess.stderr.write('[ts] WARN: line\n')).toBe(true);
    expect(error).toHaveBeenCalledWith('[ts] WARN: line');
  });
});
