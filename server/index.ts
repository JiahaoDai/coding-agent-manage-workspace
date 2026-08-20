import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { AdapterRegistry } from './adapters/registry';
import { ClaudeAdapter } from './adapters/claude';
import { FakeAdapter } from './adapters/fake';
import { createOpencodeSdk, OpenCodeAdapter } from './adapters/opencode';
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
// Claude Code (ticket #9) and OpenCode (ticket #10) are real; Pi stays on the
// fake adapter until its adapter lands (ticket #11).
//
// OpenCode's spawned server defaults to the `deepseek-v4-flash` model (a
// configured hpc-ai provider, reference `deepseek/deepseek-v4-flash`) so
// sessions use it instead of the rate-limited default. Override via OPENCODE_MODEL.
adapters.register('claude', new ClaudeAdapter());
adapters.register('opencode', new OpenCodeAdapter(createOpencodeSdk({ model: process.env.OPENCODE_MODEL ?? 'deepseek/deepseek-v4-flash' })));
adapters.register('pi', new FakeAdapter());
const sse = new SseHub();
const app = createApp({ store, adapters, sse, fs: createFsTree() });

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`coding-agent-dashboard server listening on http://localhost:${info.port}`);
});
