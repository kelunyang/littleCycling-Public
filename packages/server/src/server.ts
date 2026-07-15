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
import { EuroVeloCatalog } from './lib/eurovelo-catalog.js';

import routeApi from './routes/route-api.js';
import configApi from './routes/config-api.js';
import recordingApi from './routes/recording-api.js';
import liveApi from './routes/live-api.js';
import rideApi from './routes/ride-api.js';
import messageApi from './routes/message-api.js';
import debugApi from './routes/debug-api.js';
import planApi from './routes/plan-api.js';
import analysisApi from './routes/analysis-api.js';
import llmApi from './routes/llm-api.js';
import llmProvidersApi from './routes/llm-providers-api.js';
import catalogApi from './routes/catalog-api.js';
import { DebugWriter } from './lib/debug-writer.js';
import { migratePlanFilesToDb } from './lib/plan-file-migration.js';
import { checkForUpdate } from './lib/update-checker.js';

// ── Parse CLI args ──

const args = process.argv.slice(2);
let portOverride: number | undefined;
let dataDir = resolve(process.cwd(), 'data');
let mock = false;
let replayArg: string | undefined;
let replaySpeed = 1;
let replayLoop = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--port' && args[i + 1]) {
    portOverride = parseInt(args[++i], 10);
  } else if (arg === '--data-dir' && args[i + 1]) {
    dataDir = resolve(args[++i]);
  } else if (arg === '--mock') {
    mock = true;
  } else if (arg === '--replay' && args[i + 1]) {
    replayArg = args[++i];
  } else if (arg === '--replay-speed' && args[i + 1]) {
    replaySpeed = parseFloat(args[++i]) || 1;
  } else if (arg === '--replay-loop') {
    replayLoop = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log('Usage: npx tsx src/server.ts [--port N] [--data-dir path] [--mock]');
    console.log('       [--replay <file.jsonl>] [--replay-speed N] [--replay-loop]');
    console.log('');
    console.log('  --replay drives the game simulation from a recorded ride instead of');
    console.log('  live sensors. <file> is resolved against <data-dir>/sessions, then');
    console.log('  <data-dir>, then as given (absolute or cwd-relative).');
    process.exit(0);
  }
}

// Resolve a --replay file against the likely recording locations so the user
// can pass a bare filename (e.g. `--replay ride-7-....jsonl`).
let replayFile: string | undefined;
if (replayArg) {
  const candidates = [
    resolve(dataDir, 'sessions', replayArg),
    resolve(dataDir, replayArg),
    resolve(process.cwd(), replayArg),
    resolve(replayArg),
  ];
  replayFile = candidates.find((p) => existsSync(p));
  if (!replayFile) {
    console.error(`[replay] file not found: ${replayArg}`);
    console.error('[replay] looked in:');
    for (const c of candidates) console.error(`  - ${c}`);
    process.exit(1);
  }
  console.log(`[replay] driving simulation from: ${replayFile}`);
  console.log(`[replay] speed=${replaySpeed}x, loop=${replayLoop}`);
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

const euroveloCatalog = new EuroVeloCatalog(dataDir);

const relay = new WsRelay();

// ── SQLite database ──

const dbPath = resolve(dataDir, 'littlecycling.db');
const db = new RideDatabase(dbPath);

// ── One-time migration: LLM providers config.json → SQLite ──
// Old configs kept providers (incl. plaintext API keys) in config.json's `llm[]`.
// They now live in SQLite. On first boot after the upgrade, move any legacy
// providers into the DB (only if the DB table is still empty), then re-save the
// config to strip the stale `llm[]` key from config.json.
const legacyLlm = configStore.takeLegacyLlm();
if (legacyLlm.length > 0) {
  if (db.countLlmProviders() === 0) {
    db.replaceLlmProviders(legacyLlm);
    console.log(`[migrate] moved ${legacyLlm.length} LLM provider(s) from config.json into SQLite`);
  } else {
    console.log(`[migrate] config.json had ${legacyLlm.length} legacy LLM provider(s) but SQLite already has some — dropping from config.json`);
  }
  configStore.save({}); // rewrite config.json without the `llm[]` key
}

// ── One-time migration: 課表 JSON 檔 data/plans/*.json → SQLite ──
// 課表本體原本存成 JSON 檔（PlanStore），現改存 `plans` 表。啟動時把任何殘留
// 的舊檔搬進 DB 並改名為 .migrated（天然冪等，重啟不重覆）。
const migratedPlans = migratePlanFilesToDb(db, resolve(dataDir, 'plans'));
if (migratedPlans > 0) {
  console.log(`[migrate] moved ${migratedPlans} plan file(s) from data/plans into SQLite`);
}

// ── Debug writer ──

const debugWriter = new DebugWriter(dataDir);

// ── LiveSession (sensor connection + recording) ──

const liveSession = new LiveSession({
  relay, db, dataDir, configStore, mock,
  replayFile, replaySpeed, replayLoop,
});

// ── Build Fastify server ──

const fastify = Fastify({
  logger: false,
  // debug:預設的 clientErrorHandler 只回 400 {"message":"Client Error"},
  // 完全不說原因。這裡把底層解析錯誤(HPE_* 錯誤碼,如 HPE_HEADER_OVERFLOW
  // = header 超過 Node 16KB 上限)log 出來,再回同樣的 400。
  clientErrorHandler(err, socket) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    console.error(`[server] client error: ${code} — ${err.message}`);
    if (socket.writable) {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
        `{"error":"Bad Request","message":"Client Error","code":"${code}","statusCode":400}`,
      );
    }
  },
});

await fastify.register(fastifyCors, { origin: true });
await fastify.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB
await fastify.register(fastifyWebSocket);

// ── REST API routes ──

await fastify.register(routeApi, { routeStore });
await fastify.register(configApi, { configStore });
await fastify.register(recordingApi, { dataDir });
await fastify.register(liveApi, { liveSession, routeStore });
await fastify.register(rideApi, { db });
await fastify.register(messageApi, { db });
await fastify.register(debugApi, { debugWriter });
await fastify.register(planApi, { db, configStore, routeStore });
await fastify.register(analysisApi, { db, configStore, routeStore });
await fastify.register(llmApi, { db });
await fastify.register(llmProvidersApi, { db });
await fastify.register(catalogApi, { routeStore, catalog: euroveloCatalog });

// ── WebSocket: live sensor relay ──

fastify.get('/ws/live', { websocket: true }, (socket) => {
  relay.addClient(socket);
  // Push current session state immediately (solves late-join)
  socket.send(JSON.stringify(liveSession.getStatusMessage()));
  // Late joiner / reconnect: force a full coin reconcile in the next
  // game_state frame so the client's coin set converges immediately.
  liveSession.requestGameReconcile();
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
  console.log(`  REST    http://localhost:${port}/api/live/status`);
  console.log(`  REST    http://localhost:${port}/api/rides`);
  console.log(`  WS      ws://localhost:${port}/ws/live`);
  console.log(`  WS      ws://localhost:${port}/ws/replay?file=<name>`);

  // Check for a newer public release (git HEAD vs public repo tip); persist the
  // result into config.json so the Welcome screen can prompt a `git pull`.
  // Fire-and-forget — never blocks startup, sanely no-ops if git/network is absent.
  checkForUpdate(process.cwd(), configStore.get().update)
    .then((update) => configStore.save({ update }))
    .catch((err) => console.warn('Update check failed:', err));
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
