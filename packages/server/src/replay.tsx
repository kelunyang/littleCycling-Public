/**
 * Standalone replay CLI — replays a JSONL recording via WebSocket.
 *
 * Interactive mode (no args):  npx tsx src/replay.tsx
 * Direct mode:                 npx tsx src/replay.tsx <file.jsonl> [--speed N] [--loop] [--port N]
 */

import React, { useState, useCallback } from 'react';
import { render, useApp, Box, Text } from 'ink';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_REPLAY_PORT } from '@littlecycling/shared';
import { ReplaySession } from './lib/ws-replay.js';
import { ReplaySetup, type ReplaySettings } from './ui/ReplaySetup.js';

// ── Parse CLI args ──

const args = process.argv.slice(2);
let filePath = '';
let speed = 1;
let loop = false;
let port = DEFAULT_REPLAY_PORT;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--speed' && args[i + 1]) {
    speed = parseFloat(args[++i]);
  } else if (arg === '--loop') {
    loop = true;
  } else if (arg === '--port' && args[i + 1]) {
    port = parseInt(args[++i], 10);
  } else if (arg === '--help' || arg === '-h') {
    console.log('Usage: npx tsx src/replay.tsx [file.jsonl] [--speed N] [--loop] [--port N]');
    console.log('       If no file is given, an interactive setup screen will appear.');
    process.exit(0);
  } else if (!arg.startsWith('-')) {
    filePath = resolve(arg);
  }
}

// ── Direct mode (file specified via CLI) ──

if (filePath) {
  if (!existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }
  startServer({ filePath, speed, loop });
} else {
  // ── Interactive mode (Ink UI) ──
  const recordingsDir = resolve(process.cwd(), 'recordings');

  type Phase = 'setup' | 'running';

  function ReplayApp() {
    const { exit } = useApp();
    const [phase, setPhase] = useState<Phase>('setup');
    const [settings, setSettings] = useState<ReplaySettings | null>(null);

    const handleSubmit = useCallback((s: ReplaySettings) => {
      setSettings(s);
      setPhase('running');
      startServer(s).catch((err) => {
        console.error('Replay error:', err);
        exit();
      });
    }, [exit]);

    if (phase === 'setup') {
      return <ReplaySetup defaultDir={recordingsDir} onSubmit={handleSubmit} />;
    }

    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box marginBottom={1}>
          <Text color="gray">  Waiting for WebSocket connections...</Text>
        </Box>
        <Box borderStyle="double" borderColor="green" paddingX={2} justifyContent="center">
          <Text bold color="green">littleCycling Replay - Running</Text>
        </Box>
        <Box flexDirection="column" gap={0}>
          <Text>  File:  <Text color="cyan">{settings!.filePath}</Text></Text>
          <Text>  Speed: <Text color="cyan">{settings!.speed}x</Text></Text>
          <Text>  Loop:  <Text color="cyan">{settings!.loop ? 'ON' : 'OFF'}</Text></Text>
          <Text>  Port:  <Text color="cyan">{port}</Text></Text>
        </Box>
        <Box>
          <Text dimColor color="gray">  (Ctrl+C to stop)</Text>
        </Box>
      </Box>
    );
  }

  render(<ReplayApp />);
}

// ── Server logic ──

function startServer(opts: { filePath: string; speed: number; loop: boolean }): Promise<void> {
  return new Promise((resolvePromise) => {
    const wss = new WebSocketServer({ port });
    const sessions = new Set<ReplaySession>();

    if (filePath) {
      // Direct mode — log to console
      console.log(`Replay server listening on ws://localhost:${port}`);
      console.log(`  File:  ${opts.filePath}`);
      console.log(`  Speed: ${opts.speed}x`);
      console.log(`  Loop:  ${opts.loop}`);
      console.log('');
      console.log('Waiting for WebSocket connections...');
    }

    wss.on('connection', (ws: WebSocket) => {
      const session = new ReplaySession(ws, {
        filePath: opts.filePath,
        speed: opts.speed,
        loop: opts.loop,
      });
      sessions.add(session);

      ws.on('close', () => {
        session.stop();
        sessions.delete(session);
      });

      session.start().catch((err) => {
        console.error('Replay error:', err);
      });
    });

    function shutdown() {
      for (const session of sessions) session.stop();
      wss.close(() => {
        resolvePromise();
        process.exit(0);
      });
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
