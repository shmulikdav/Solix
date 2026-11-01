import { resolvePort } from '@solix/shared';
import { createSolixServer } from './create.js';

export { createSolixServer } from './create.js';
export type { SolixServerHandle, SolixServerOptions } from './create.js';

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('packages/server/src/index.ts') ||
  process.argv[1]?.endsWith('packages/server/dist/index.js');

if (isMain) {
  const port = resolvePort();
  createSolixServer({ port })
    .then((h) => {
      console.log(
        `[solix] server listening on http://${h.hostname}:${h.port}`,
      );
      console.log(`[solix] events  -> POST http://${h.hostname}:${h.port}/events`);
      console.log(`[solix] ws      -> ws://${h.hostname}:${h.port}/ws`);
    })
    .catch((err) => {
      console.error('[solix] failed to start', err);
      process.exit(1);
    });
}
