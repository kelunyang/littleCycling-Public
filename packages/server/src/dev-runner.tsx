#!/usr/bin/env node
/**
 * littleCycling Dev Runner
 *
 * Starts all dev services (shared, server, web, caddy) in one command
 * with an Ink UI showing status and logs.
 *
 * A lightweight proxy on port 8770 sits between Vite and the backends.
 * It continuously monitors port 8766 and hot-switches WebSocket traffic
 * to the replay server when detected, so startup order doesn't matter.
 *
 * Usage:
 *   npx tsx src/dev-runner.tsx
 *   npx tsx src/dev-runner.tsx --caddy       # also start Caddy
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, useApp, useInput, Box, Text } from 'ink';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_WS_PORT, DEFAULT_REPLAY_PORT, DEFAULT_DEV_PROXY_PORT, parseHrData, parseScData, parsePwrData } from '@littlecycling/shared';
import { DevProxy } from './lib/dev-proxy.js';

// ── Config ──

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const args = process.argv.slice(2);
const withCaddy = args.includes('--caddy');

/** Check if a TCP port is already in use */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => { resolve(false); });
  });
}

interface ServiceConfig {
  name: string;
  label: string;
  color: string;
  command: string;
  args: string[];
  cwd: string;
  readyPattern: RegExp;
  readyText: string;
}

interface ServiceEnv {
  [key: string]: string;
}

interface ServiceConfigExt extends ServiceConfig {
  env?: ServiceEnv;
}

function getServices(): ServiceConfigExt[] {
  const services: ServiceConfigExt[] = [
    {
      name: 'shared',
      label: 'shared',
      color: 'magenta',
      command: 'npx',
      args: ['tsc', '--watch', '--preserveWatchOutput'],
      cwd: path.join(ROOT, 'packages/shared'),
      readyPattern: /Watching for file changes|Found 0 errors/,
      readyText: 'watching',
    },
    {
      name: 'server',
      label: 'server',
      color: 'cyan',
      command: 'npx',
      args: ['tsx', 'src/server.ts', '--data-dir', path.join(ROOT, 'data')],
      cwd: path.join(ROOT, 'packages/server'),
      readyPattern: /listening|started|Server running/i,
      readyText: `:${DEFAULT_WS_PORT}`,
    },
    {
      name: 'web',
      label: 'web',
      color: 'green',
      command: 'npx',
      args: ['vite'],
      cwd: path.join(ROOT, 'packages/web'),
      readyPattern: /ready in|Local:/,
      readyText: ':5173',
      env: { VITE_WS_PORT: String(DEFAULT_DEV_PROXY_PORT) },
    },
  ];

  if (withCaddy) {
    const caddyConfig = 'Caddyfile.example';
    services.push({
      name: 'caddy',
      label: 'caddy',
      color: 'yellow',
      command: 'caddy',
      args: ['run', '--config', caddyConfig],
      cwd: ROOT,
      readyPattern: /serving|Caddy|autosaved/i,
      readyText: ':3000',
    });
  }

  return services;
}

// ── Types ──

type ServiceStatus = 'starting' | 'ready' | 'error' | 'exited';

interface LogLine {
  service: string;
  color: string;
  text: string;
  time: string;
}

const MAX_LOG_LINES = 30;

// ── Components ──

function StatusDot({ status }: { status: ServiceStatus }) {
  const char = '●';
  const color =
    status === 'ready' ? 'green' :
    status === 'starting' ? 'yellow' :
    status === 'error' ? 'red' :
    'gray';
  return <Text color={color}>{char}</Text>;
}

function ServiceStatusBar({ services }: { services: Array<{ name: string; label: string; status: ServiceStatus; readyText: string }> }) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} gap={3}>
      {services.map((svc) => (
        <Box key={svc.name} gap={1}>
          <Text bold color="white">{svc.label}</Text>
          <StatusDot status={svc.status} />
          <Text dimColor color="gray">
            {svc.status === 'ready' ? svc.readyText :
             svc.status === 'starting' ? 'starting...' :
             svc.status === 'error' ? 'error' : 'exited'}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

interface SensorSnapshot {
  hr?: number;
  speed?: number;
  cadence?: number;
  power?: number;
}

function SensorBar({ data }: { data: SensorSnapshot | null }) {
  if (!data) return null;
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} gap={2}>
      <Box gap={1}><Text bold color="red">HR</Text><Text>{data.hr ?? '--'}</Text></Box>
      <Box gap={1}><Text bold color="green">SPD</Text><Text>{data.speed?.toFixed(1) ?? '--'}</Text></Box>
      <Box gap={1}><Text bold color="blue">CAD</Text><Text>{data.cadence ?? '--'}</Text></Box>
      <Box gap={1}><Text bold color="magenta">PWR</Text><Text>{data.power ?? '--'}</Text></Box>
    </Box>
  );
}

function LogView({ lines }: { lines: LogLine[] }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {lines.map((line, i) => (
        <Box key={i} gap={1}>
          <Text dimColor color="gray">{line.time}</Text>
          <Text color={line.color as any} bold>[{line.service}]</Text>
          <Text>{line.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ── App ──

function App() {
  const { exit } = useApp();
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>({});
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [replayActive, setReplayActive] = useState(false);
  const [sensorData, setSensorData] = useState<SensorSnapshot | null>(null);
  const processesRef = useRef<ChildProcess[]>([]);
  const proxyRef = useRef<DevProxy | null>(null);
  const shuttingDownRef = useRef(false);

  const addLog = useCallback((service: string, color: string, text: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogLines((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), { service, color, text, time }]);
  }, []);

  const shutdown = useCallback(() => {
    if (shuttingDownRef.current) return;
    shuttingDownRef.current = true;
    addLog('dev', 'cyan', 'Shutting down all services...');

    proxyRef.current?.stop();

    for (const proc of processesRef.current) {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    }

    setTimeout(() => {
      for (const proc of processesRef.current) {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }
      exit();
      process.exit(0);
    }, 300);
  }, [exit, addLog]);

  // ── Dev proxy + replay polling ──

  useEffect(() => {
    const proxy = new DevProxy(DEFAULT_DEV_PROXY_PORT, DEFAULT_WS_PORT, DEFAULT_WS_PORT);
    proxyRef.current = proxy;

    proxy.start().then(() => {
      addLog('dev', 'cyan', `Proxy listening on :${DEFAULT_DEV_PROXY_PORT} → :${DEFAULT_WS_PORT}`);
    }).catch((err) => {
      addLog('dev', 'red', `Failed to start proxy on :${DEFAULT_DEV_PROXY_PORT}: ${(err as Error).message}`);
    });

    const timer = setInterval(async () => {
      if (shuttingDownRef.current) return;
      const replayUp = await isPortInUse(DEFAULT_REPLAY_PORT);
      setReplayActive((prev) => {
        if (prev !== replayUp) {
          const newTarget = replayUp ? DEFAULT_REPLAY_PORT : DEFAULT_WS_PORT;
          proxy.setWsUpstream(newTarget);
          addLog('dev', 'yellow',
            replayUp
              ? `Replay detected on :${DEFAULT_REPLAY_PORT} — switching WS to replay`
              : `Replay disconnected — switching WS back to :${DEFAULT_WS_PORT}`,
          );
        }
        return replayUp;
      });
    }, 3000);

    return () => {
      clearInterval(timer);
      proxy.stop();
    };
  }, [addLog]);

  // ── Spawn services ──

  useEffect(() => {
    const services = getServices();

    const initialStatuses: Record<string, ServiceStatus> = {};
    for (const svc of services) {
      initialStatuses[svc.name] = 'starting';
    }
    setStatuses(initialStatuses);

    addLog('dev', 'cyan', `Starting ${services.length} services...`);

    for (const svc of services) {
      const proc = spawn(svc.command, svc.args, {
        cwd: svc.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env, FORCE_COLOR: '1', ...((svc as ServiceConfigExt).env ?? {}) },
      });

      processesRef.current.push(proc);

      const handleOutput = (data: Buffer) => {
        const text = data.toString().trim();
        if (!text) return;

        // Check for ready pattern
        if (svc.readyPattern.test(text)) {
          setStatuses((prev) => ({ ...prev, [svc.name]: 'ready' }));
        }

        // Split multi-line output and add each line
        const lines = text.split('\n');
        for (const line of lines) {
          const clean = line.trim();
          if (clean) {
            addLog(svc.label, svc.color, clean);
          }
        }
      };

      proc.stdout?.on('data', handleOutput);
      proc.stderr?.on('data', handleOutput);

      proc.on('error', (err) => {
        setStatuses((prev) => ({ ...prev, [svc.name]: 'error' }));
        addLog(svc.label, 'red', `Failed to start: ${err.message}`);
      });

      proc.on('exit', (code) => {
        if (!shuttingDownRef.current) {
          setStatuses((prev) => ({
            ...prev,
            [svc.name]: code === 0 ? 'exited' : 'error',
          }));
          addLog(svc.label, code === 0 ? 'gray' : 'red', `Exited (code ${code})`);
        }
      });
    }

    return () => {
      for (const proc of processesRef.current) {
        if (!proc.killed) proc.kill('SIGTERM');
      }
    };
  }, [addLog]);

  // ── Sensor data via WebSocket ──

  const serverReady = statuses['server'] === 'ready';

  useEffect(() => {
    if (!serverReady) return;

    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let closed = false;

    function connect() {
      if (closed) return;
      ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_DEV_PROXY_PORT}/ws/live`);

      ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'sensor') {
            setSensorData((prev) => {
              const next = { ...prev };
              if (msg.profile === 'HR') {
                next.hr = parseHrData(msg.data).heartRate;
              } else if (['SC', 'SPD', 'CAD'].includes(msg.profile)) {
                const sc = parseScData(msg.data);
                next.speed = sc.speed;
                next.cadence = sc.cadence;
              } else if (msg.profile === 'PWR') {
                next.power = parsePwrData(msg.data).power;
              }
              return next;
            });
          }
        } catch { /* ignore malformed */ }
      });

      ws.on('close', () => {
        if (!closed) reconnectTimer = setTimeout(connect, 3000);
      });

      ws.on('error', () => { /* onclose handles reconnect */ });
    }

    connect();
    addLog('dev', 'yellow', `Sensor WS connected via proxy :${DEFAULT_DEV_PROXY_PORT}`);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [serverReady, addLog]);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      shutdown();
    }
  });

  const services = getServices();
  const wsTarget = replayActive ? DEFAULT_REPLAY_PORT : DEFAULT_WS_PORT;
  const statusList: Array<{ name: string; label: string; status: ServiceStatus; readyText: string }> = services.map((svc) => ({
    name: svc.name,
    label: svc.label,
    status: statuses[svc.name] ?? 'starting' as ServiceStatus,
    readyText: svc.readyText,
  }));

  // Append replay indicator when active
  if (replayActive) {
    statusList.push({
      name: 'replay',
      label: 'replay',
      status: 'ready',
      readyText: `:${DEFAULT_REPLAY_PORT}`,
    });
  }

  // Append proxy indicator
  statusList.push({
    name: 'proxy',
    label: 'proxy',
    status: 'ready',
    readyText: `:${DEFAULT_DEV_PROXY_PORT} → :${wsTarget}`,
  });

  return (
    <Box flexDirection="column">
      <LogView lines={logLines} />
      <Box borderStyle="double" borderColor="cyan" paddingX={2} justifyContent="center">
        <Text bold color="cyan">littleCycling Dev</Text>
      </Box>
      <ServiceStatusBar services={statusList} />
      <SensorBar data={sensorData} />
      <Box paddingX={1}>
        <Text dimColor color="gray">Press </Text>
        <Text bold color="white">Ctrl+C</Text>
        <Text dimColor color="gray"> to stop all services</Text>
      </Box>
    </Box>
  );
}

// ── Start ──
render(<App />, { exitOnCtrlC: false });
