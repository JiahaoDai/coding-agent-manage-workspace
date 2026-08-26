import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { AdapterRegistry } from './adapters/registry';
import { ClaudeAdapter } from './adapters/claude';
import { createOpencodeSdk, OpenCodeAdapter } from './adapters/opencode';
import { createPiSdk, PiAdapter } from './adapters/pi';
import { createApp } from './app';
import { SessionStore } from './db';
import { createFsTree } from './fs/tree';
import { SseHub } from './sse';

const DB_PATH = process.env.DB_PATH ?? 'data/sessions.db';
const PORT = Number(process.env.PORT ?? 4000);

if (DB_PATH !== ':memory:') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
const store = new SessionStore(db);
const adapters = new AdapterRegistry();
// Claude Code (ticket #9), OpenCode (ticket #10), and Pi (ticket #11) are real.
//
// OpenCode's spawned server defaults to the `deepseek-v4-flash` model (a
// configured hpc-ai provider, reference `deepseek/deepseek-v4-flash`) so
// sessions use it instead of the rate-limited default. Override via OPENCODE_MODEL.
//
// Pi resolves its own default model (settings → first available) unless PI_MODEL
// is set to a Pi CLI model string (e.g. `deepseek/deepseek-v4-flash`).
adapters.register('claude', new ClaudeAdapter());
adapters.register('opencode', new OpenCodeAdapter(createOpencodeSdk({ model: process.env.OPENCODE_MODEL ?? 'deepseek/deepseek-v4-flash' })));
adapters.register('pi', new PiAdapter(createPiSdk({ model: process.env.PI_MODEL })));
const sse = new SseHub();
const app = createApp({ store, adapters, sse, fs: createFsTree() });

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`coding-agent-dashboard server listening on http://localhost:${info.port}`);
});

let closing = false;
async function closeResources(): Promise<void> {
  if (closing) return;
  closing = true;
  await adapters.closeAll();
}

type CloseableServer = typeof server & {
  on?(event: 'close', listener: () => void): void;
  close?(callback?: (err?: Error) => void): void;
};

const closeableServer = server as CloseableServer;
closeableServer.on?.('close', () => {
  void closeResources();
});

function shutdown(signal: NodeJS.Signals): void {
  void (async () => {
    console.log(`Received ${signal}; shutting down coding-agent-dashboard server.`);
    await closeResources();
    await new Promise<void>((resolve) => {
      closeableServer.close?.(() => resolve());
      if (!closeableServer.close) resolve();
    });
    db.close();
    process.exit(0);
  })().catch((err) => {
    console.error('Failed during shutdown', err);
    process.exit(1);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
