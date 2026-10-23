/**
 * Node globals for the browser bundle, injected by esbuild (see scripts/browser/node-shims.mjs).
 *
 * - `Buffer`: the `buffer` package, a port of Node's Buffer, used by about 20 shared modules.
 * - `process`: only what shared code may reach in the browser. `env` is empty (environment-based
 *   settings read as unset); `stderr.write` goes to the console, so the default stderr log sink acts as
 *   a console sink. Other properties are absent, as feature detection in dependencies expects.
 */
export { Buffer } from 'buffer';

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: ReadonlySet<string> = new Set<ConsoleMethod>(['debug', 'info', 'warn', 'error']);

/**
 * The console method for one log line, from the level the logger wrote into it: text lines start
 * `[timestamp] LEVEL: `, JSON lines carry a top-level `level`. Anything else stays on `console.error`,
 * where Node's stderr output would have been, so no line is hidden by a lower console level.
 */
export function consoleMethodFor(line: string): ConsoleMethod {
  const text = /^\[[^\]]*\] ([A-Z]+): /.exec(line)?.[1]?.toLowerCase();
  if (text !== undefined) return LEVELS.has(text) ? (text as ConsoleMethod) : 'error';
  if (line.startsWith('{')) {
    try {
      const level = (JSON.parse(line) as { level?: unknown }).level;
      if (typeof level === 'string' && LEVELS.has(level)) return level as ConsoleMethod;
    } catch {
      // Not a JSON log line.
    }
  }
  return 'error';
}

export const process = {
  env: {} as Record<string, string | undefined>,
  stderr: {
    write(chunk: string): boolean {
      const line = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk;
      console[consoleMethodFor(line)](line);
      return true;
    },
  },
};
