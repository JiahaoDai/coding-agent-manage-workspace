import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { AdapterRegistry } from './adapters/registry';
import { FakeAdapter } from './adapters/fake';
import { createApp } from './app';
import { SessionStore } from './db';
import { SseHub } from './sse';

const DB_PATH = process.env.DB_PATH ?? 'data/sessions.db';
const PORT = Number(process.env.PORT ?? 4000);

if (DB_PATH !== ':memory:') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
const store = new SessionStore(db);
const adapters = new AdapterRegistry();
// Until the real adapters (tickets #9–#11) land, every known agent is driven
// by the fake adapter so the app works end-to-end.
for (const id of ['claude', 'opencode', 'pi']) {
  adapters.register(id, new FakeAdapter());
}
const sse = new SseHub();
const app = createApp({ store, adapters, sse });

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`coding-agent-dashboard server listening on http://localhost:${info.port}`);
});
