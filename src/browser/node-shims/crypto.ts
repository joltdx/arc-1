/**
 * Browser stand-in for the `node:crypto` subset that shared ARC-1 code uses.
 *
 * The browser build redirects `node:crypto` here (see scripts/browser/node-shims.mjs). Only the
 * call shapes found in shared code are implemented; anything else throws, so a new upstream use
 * fails the shimmed test run instead of silently hashing differently.
 *
 * Supported: `createHash('sha256').update(string | Uint8Array[, 'utf8']).digest('hex')` and
 * `randomBytes(n).toString('hex')`.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

class UnsupportedShimError extends Error {
  constructor(what: string) {
    super(`node:crypto browser shim: ${what} is not supported`);
    this.name = 'UnsupportedShimError';
  }
}

export interface Hash {
  update(data: string | Uint8Array, inputEncoding?: 'utf8' | 'utf-8'): Hash;
  digest(encoding: 'hex'): string;
}

export function createHash(algorithm: string): Hash {
  if (algorithm !== 'sha256') throw new UnsupportedShimError(`createHash('${algorithm}')`);
  const state = sha256.create();
  let finished = false;
  const hash: Hash = {
    update(data, inputEncoding) {
      if (finished) throw new UnsupportedShimError('update() after digest()');
      if (typeof data === 'string') {
        if (inputEncoding !== undefined && inputEncoding !== 'utf8' && inputEncoding !== 'utf-8') {
          throw new UnsupportedShimError(`update() input encoding '${inputEncoding}'`);
        }
        state.update(utf8ToBytes(data));
      } else if (data instanceof Uint8Array) {
        state.update(data);
      } else {
        throw new UnsupportedShimError('update() with a non-string, non-Uint8Array value');
      }
      return hash;
    },
    digest(encoding) {
      if (encoding !== 'hex') throw new UnsupportedShimError(`digest('${String(encoding)}')`);
      if (finished) throw new UnsupportedShimError('digest() twice');
      finished = true;
      return bytesToHex(state.digest());
    },
  };
  return hash;
}

export interface RandomBytes extends Uint8Array {
  toString(encoding?: 'hex'): string;
}

export function randomBytes(size: number): RandomBytes {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return Object.assign(bytes, {
    toString(encoding?: 'hex'): string {
      if (encoding !== 'hex') throw new UnsupportedShimError(`randomBytes().toString('${String(encoding)}')`);
      return bytesToHex(bytes);
    },
  });
}
