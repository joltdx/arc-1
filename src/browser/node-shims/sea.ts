/**
 * Browser stand-in for `node:sea`, scoped to src/aff/validator.ts (see scripts/browser/node-shims.mjs).
 *
 * The validator already reads AFF schemas as embedded assets in single-executable builds
 * (`isSea()` → `getAsset('aff/<file>')`). The browser bundle embeds them the same way, so it reports
 * itself as having embedded assets and serves the schemas from the bundle.
 */
import bdef from '../../aff/schemas/bdef-v1.json';
import clas from '../../aff/schemas/clas-v1.json';
import ddls from '../../aff/schemas/ddls-v1.json';
import intf from '../../aff/schemas/intf-v1.json';
import prog from '../../aff/schemas/prog-v1.json';
import srvb from '../../aff/schemas/srvb-v1.json';
import srvd from '../../aff/schemas/srvd-v1.json';

/** Every file in src/aff/schemas/; a unit test fails when upstream adds one that is missing here. */
export const EMBEDDED_ASSETS: Readonly<Record<string, unknown>> = {
  'aff/bdef-v1.json': bdef,
  'aff/clas-v1.json': clas,
  'aff/ddls-v1.json': ddls,
  'aff/intf-v1.json': intf,
  'aff/prog-v1.json': prog,
  'aff/srvb-v1.json': srvb,
  'aff/srvd-v1.json': srvd,
};

export function isSea(): boolean {
  return true;
}

export function getAsset(key: string, encoding?: string): string {
  if (encoding !== 'utf8') throw new Error(`node:sea browser shim: getAsset() encoding '${encoding}' is not supported`);
  const asset = EMBEDDED_ASSETS[key];
  if (asset === undefined) throw new Error(`node:sea browser shim: no embedded asset '${key}'`);
  return JSON.stringify(asset);
}
