/**
 * littleCycling server — HTTP REST API + WebSocket relay/replay + live sensor session.
 *
 * Usage:
 *   npx tsx src/server.ts [--port N] [--data-dir path]
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';

import { DEFAULT_WS_PORT } from '@littlecycling/shared';
import { ConfigStore } from './lib/config-store.js';
import { RouteStore } from './lib/route-store.js';
import { WsRelay } from './lib/ws-relay.js';
import { ReplaySession } from './lib/ws-replay.js';
import { RideDatabase } from './lib/database.js';
import { LiveSession, type LiveSensorSnapshot } from './lib/live-session.js';

import routeApi from './routes/route-api.js';
import configApi from './routes/config-api.js';
import recordingApi from './routes/recording-api.js';
import catalogApi from './routes/catalog-api.js';
import liveApi from './routes/live-api.js';
import rideApi from './routes/ride-api.js';
import messageApi from './routes/message-api.js';
import debugApi from './routes/debug-api.js';
import planApi from './routes/plan-api.js';
import llmApi from './routes/llm-api.js';
import { DebugWriter } from './lib/debug-writer.js';
import { PlanStore } from './lib/plan-store.js';

// ── Parse CLI args ──

const args = process.argv.slice(2);
let portOverride: number | undefined;
let dataDir = resolve(process.cwd(), 'data');

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--port' && args[i + 1]) {
    portOverride = parseInt(args[++i], 10);
  } else if (arg === '--data-dir' && args[i + 1]) {
    dataDir = resolve(args[++i]);
  } else if (arg === '--help' || arg === '-h') {
    console.log('Usage: npx tsx src/server.ts [--port N] [--data-dir path]');
    process.exit(0);
  }
}

// ── Initialize stores ──

const configStore = new ConfigStore(resolve(dataDir, 'config.json'));
configStore.load();

const config = configStore.get();
const port = portOverride ?? config.server.wsPort ?? DEFAULT_WS_PORT;

const routeStore = new RouteStore(resolve(dataDir, 'routes'));

// Auto-import any raw GPX/TCX/FIT files dropped into data/routes/
routeStore.autoImport().then((count) => {
  if (count > 0) console.log(`[auto-import] Imported ${count} route file(s)`);
}).catch((err) => {
  console.warn('[auto-import] Error during auto-import:', err);
});

const planStore = new PlanStore(resolve(dataDir, 'plans'));

const relay = new WsRelay();

// ── SQLite database ──

const dbPath = resolve(dataDir, 'littlecycling.db');
const db = new RideDatabase(dbPath);

// ── Debug writer ──

const debugWriter = new DebugWriter(dataDir);

// ── LiveSession (sensor connection + recording) ──

const liveSession = new LiveSession({ relay, db });

// ── Build Fastify server ──

const fastify = Fastify({ logger: false });

await fastify.register(fastifyCors, { origin: true });
await fastify.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB
await fastify.register(fastifyWebSocket);

// ── REST API routes ──

await fastify.register(routeApi, { routeStore });
await fastify.register(configApi, { configStore });
await fastify.register(recordingApi, { dataDir });
await fastify.register(catalogApi, { routeStore });
await fastify.register(liveApi, { liveSession });
await fastify.register(rideApi, { db });
await fastify.register(messageApi, { db });
await fastify.register(debugApi, { debugWriter });
await fastify.register(planApi, { planStore, db, configStore });
await fastify.register(llmApi, { db, configStore });

// ── WebSocket: live sensor relay ──

fastify.get('/ws/live', { websocket: true }, (socket) => {
  relay.addClient(socket);
  // Push current session state immediately (solves late-join)
  socket.send(JSON.stringify(liveSession.getStatusMessage()));
  console.log(`[ws/live] client connected (total: ${relay.clientCount})`);
  socket.on('close', () => {
    console.log(`[ws/live] client disconnected (total: ${relay.clientCount})`);
  });
});

// ── WebSocket: replay ──

fastify.get<{
  Querystring: { file?: string; speed?: string; loop?: string };
}>('/ws/replay', { websocket: true }, (socket, req) => {
  const fileName = req.query.file;
  if (!fileName) {
    socket.send(JSON.stringify({ error: 'Missing ?file= parameter' }));
    socket.close();
    return;
  }

  const filePath = resolve(dataDir, fileName);
  if (!existsSync(filePath)) {
    socket.send(JSON.stringify({ error: `File not found: ${fileName}` }));
    socket.close();
    return;
  }

  const speed = parseFloat(req.query.speed ?? '1') || 1;
  const loop = req.query.loop === 'true';

  console.log(`[ws/replay] starting: ${fileName} (speed=${speed}x, loop=${loop})`);

  const session = new ReplaySession(socket, { filePath, speed, loop });
  socket.on('close', () => {
    session.stop();
    console.log(`[ws/replay] client disconnected`);
  });

  session.start().catch((err) => {
    console.error('[ws/replay] error:', err);
  });
});

// ── Health check ──

fastify.get('/api/health', async () => ({ status: 'ok' }));

// ── Start server ──

try {
  await fastify.listen({ port, host: '0.0.0.0' });
  console.log(`littleCycling server listening on http://localhost:${port}`);
  console.log(`  Data dir: ${dataDir}`);
  console.log(`  Database: ${dbPath}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  REST    http://localhost:${port}/api/routes`);
  console.log(`  REST    http://localhost:${port}/api/config`);
  console.log(`  REST    http://localhost:${port}/api/recordings`);
  console.log(`  REST    http://localhost:${port}/api/catalog`);
  console.log(`  REST    http://localhost:${port}/api/live/status`);
  console.log(`  REST    http://localhost:${port}/api/rides`);
  console.log(`  WS      ws://localhost:${port}/ws/live`);
  console.log(`  WS      ws://localhost:${port}/ws/replay?file=<name>`);
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}

// ── Auto-scan sensors ──

console.log('');
console.log('[live] Auto-scanning for sensors...');

liveSession.on('detect', (sensor) => {
  console.log(`[live] Found: ${sensor.profile} (device: ${sensor.deviceId}, source: ${sensor.source ?? 'ant'})`);
});

liveSession.startScan().then((sensors) => {
  if (sensors.length === 0) {
    console.log('[live] No sensors detected. Live mode will run without sensors.');
    console.log('[live] Use /ws/replay for playback mode.');
  } else {
    console.log(`[live] Ready — ${sensors.length} sensor(s) detected`);
  }
}).catch((err) => {
  console.log(`[live] Sensor scan failed: ${err.message}`);
  console.log('[live] Server continues running. Use /ws/replay for playback mode.');
});

// ── Console live display ──

// ── Graceful shutdown ──

function shutdown() {
  console.log('\nShutting down...');

  debugWriter.close();
  liveSession.shutdown()
    .then(() => db.close())
    .then(() => fastify.close())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Export for external access
export { relay, liveSession, db };
