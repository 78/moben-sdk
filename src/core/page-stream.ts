// Generated from api/src/app-sdk/page-stream.ts. Do not edit here.
import type { AppPageOutput } from './types';

// One page lifecycle for short strings and long-running generators. Abort must
// also wake a reader whose handler is currently waiting for its next event.
export async function* pageChunks(output: AppPageOutput | Promise<AppPageOutput>, signal: AbortSignal): AsyncGenerator<string> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Request canceled'));
  });
  aborted.catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  let iterator: AsyncIterator<string> | undefined;
  let ended = false;
  try {
    const source = await Promise.race([output, aborted]);
    if (typeof source === 'string') { signal.throwIfAborted(); yield source; return; }
    iterator = source[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) { ended = true; return; }
      if (typeof next.value !== 'string') throw new Error('Page handlers must yield strings.');
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!ended) iterator?.return?.().catch(() => {});
  }
}
