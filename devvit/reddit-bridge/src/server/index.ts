import { serve } from '@hono/node-server';
import { context, createServer, getServerPort, reddit } from '@devvit/web/server';

import { createBridgeApp } from './app.ts';

const app = createBridgeApp({ context, reddit });

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
