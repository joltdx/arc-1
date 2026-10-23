/** Module Web Worker entry of the browser runtime (`dist/browser/worker.js`); protocol in worker-runtime.ts. */

import { serveBrowserRuntime, type WorkerScopeLike } from './worker-runtime.js';

serveBrowserRuntime(globalThis as unknown as WorkerScopeLike);
