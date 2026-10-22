/**
 * Node globals for the browser bundle, injected by esbuild (see scripts/browser/node-shims.mjs).
 *
 * - `Buffer`: the `buffer` package, a port of Node's Buffer, used by about 20 shared modules.
 * - `process`: only what shared code may reach in the browser. `env` is empty (environment-based
 *   settings read as unset); `stderr.write` goes to the console, so the default stderr log sink acts as
 *   a console sink. Other properties are absent, as feature detection in dependencies expects.
 */
export { Buffer } from 'buffer';

export const process = {
  env: {} as Record<string, string | undefined>,
  stderr: {
    write(chunk: string): boolean {
      console.error(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);
      return true;
    },
  },
};
