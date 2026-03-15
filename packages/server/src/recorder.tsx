#!/usr/bin/env node
/**
 * Sensor Recorder (ANT+ and/or BLE) — Ink-based CLI wrapper around LiveSession.
 *
 * Records sensor data directly to SQLite (no JSONL).
 *
 * Usage:
 *   npx tsx src/recorder.ts                          # Default: scan + record
 *   npx tsx src/recorder.ts --no-ble-hr              # ANT+ only, skip BLE
 *   npx tsx src/recorder.ts --verify-only            # Just verify connections, then exit
 *   npx tsx src/recorder.ts -t 15000                 # Set scan timeout to 15 seconds
 *   npx tsx src/recorder.ts --db path/to/db.sqlite   # Custom database path
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, useApp, useInput, Box, Text } from 'ink';
import path from 'node:path';
import { RideDatabase } from './lib/database.js';
import { WsRelay } from './lib/ws-relay.js';
import { LiveSession, type LiveSensorSnapshot } from './lib/live-session.js';

// ── CLI argument parsing ──

const args = process.argv.slice(2);

function getArg(flag: string, shortFlag?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag || (shortFlag && args[i] === shortFlag)) {
      return args[i + 1];
    }
  }
  return undefined;
}

function hasFlag(flag: string, shortFlag?: string): boolean {
  return args.includes(flag) || (shortFlag !== undefined && args.includes(shortFlag));
}

if (hasFlag('--help', '-h')) {
  console.log(`
Sensor Recorder - littleCycling

Usage:
  npx tsx src/recorder.ts [options]

Options:
  -t, --timeout <ms>      Sensor scan timeout in milliseconds (default: 30000)
      --no-ble-hr         Skip BLE heart rate scanning (BLE HR is on by default)
      --verify-only       Just verify connections and sensor detection, then exit
      --db <path>         SQLite database path (default: data/littlecycling.db)
      --debug             Enable debug logging
  -h, --help              Show this help message
`);
  process.exit(0);
}

const verifyOnly = hasFlag('--verify-only');
const debug = hasFlag('--debug');
const noBleHr = hasFlag('--no-ble-hr');
const scanTimeout = parseInt(getArg('--timeout', '-t') ?? '30000', 10);
const dbPath = path.resolve(getArg('--db') ?? path.join('data', 'littlecycling.db'));

// ── Helpers ──

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ── Types ──

type Phase = 'scanning' | 'recording' | 'stopping' | 'done';

interface LogLine {
  text: string;
  color: string;
  time: string;
}

const MAX_LOG_LINES = 30;

// ── Components ──

function LogView({ lines }: { lines: LogLine[] }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {lines.map((line, i) => (
        <Box key={i} gap={1}>
          <Text dimColor color="gray">{line.time}</Text>
          <Text color={line.color as any}>{line.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

function SensorBar({ data }: { data: LiveSensorSnapshot }) {
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} gap={2}>
      <Box gap={1}><Text bold color="red">HR</Text><Text>{data.hr != null ? `${data.hr} bpm` : '--'}</Text></Box>
      <Box gap={1}><Text bold color="green">SPD</Text><Text>{data.speed != null ? `${data.speed.toFixed(1)} km/h` : '--'}</Text></Box>
      <Box gap={1}><Text bold color="blue">CAD</Text><Text>{data.cadence != null ? `${data.cadence} rpm` : '--'}</Text></Box>
      <Box gap={1}><Text bold color="magenta">PWR</Text><Text>{data.power != null ? `${data.power} W` : '--'}</Text></Box>
    </Box>
  );
}

// ── App ──

function RecorderApp() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>('scanning');
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [sensorData, setSensorData] = useState<LiveSensorSnapshot>({});
  const [elapsed, setElapsed] = useState('00:00:00');
  const [rideId, setRideId] = useState<number | null>(null);
  const [sensorCount, setSensorCount] = useState(0);

  const sessionRef = useRef<LiveSession | null>(null);
  const dbRef = useRef<RideDatabase | null>(null);
  const startTimeRef = useRef(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const shuttingDownRef = useRef(false);

  const addLog = useCallback((text: string, color = 'white') => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogLines((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), { text, color, time }]);
  }, []);

  // ── Initialize session and start scan ──

  useEffect(() => {
    const db = new RideDatabase(dbPath);
    dbRef.current = db;
    const relay = new WsRelay();

    const session = new LiveSession({
      relay,
      db,
      noBleHr,
      scanTimeout,
      debug,
    });
    sessionRef.current = session;

    session.on('detect', (sensor) => {
      addLog(`Found: ${sensor.profile} (device: ${sensor.deviceId}, source: ${sensor.source ?? 'ant'})`, 'green');
      setSensorCount((c) => c + 1);
    });

    session.on('data', (snap: LiveSensorSnapshot) => {
      setSensorData(snap);
    });

    addLog(`Scanning for sensors (${scanTimeout / 1000}s timeout)...`, 'cyan');
    addLog('Tip: spin your wheel or crank to wake up speed/cadence sensor', 'gray');

    session.startScan().then(async (sensors) => {
      if (sensors.length === 0) {
        addLog('No sensors detected! Make sure sensors are active and in range.', 'red');
        db.close();
        setTimeout(() => { exit(); process.exit(1); }, 500);
        return;
      }

      addLog(`Detected ${sensors.length} sensor(s)`, 'cyan');

      if (verifyOnly) {
        addLog('[OK] Verification complete.', 'green');
        for (const s of sensors) {
          addLog(`  ${s.profile} (device: ${s.deviceId}, source: ${s.source ?? 'ant'})`, 'white');
        }
        await session.shutdown();
        db.close();
        setTimeout(() => { exit(); process.exit(0); }, 500);
        return;
      }

      // Start recording
      addLog(`Database: ${dbPath}`, 'gray');
      const id = await session.startRecording();
      setRideId(id);
      setPhase('recording');
      startTimeRef.current = Date.now();
      addLog(`Recording started (ride #${id}). Press Ctrl+C to stop.`, 'cyan');
    }).catch((err) => {
      addLog(`Error: ${(err as Error).message}`, 'red');
      db.close();
      setTimeout(() => { exit(); process.exit(1); }, 500);
    });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [addLog, exit]);

  // ── Elapsed timer ──

  useEffect(() => {
    if (phase !== 'recording') return;
    timerRef.current = setInterval(() => {
      setElapsed(formatDuration(Date.now() - startTimeRef.current));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase]);

  // ── Shutdown ──

  const shutdown = useCallback(async () => {
    if (shuttingDownRef.current) return;
    shuttingDownRef.current = true;
    setPhase('stopping');

    const session = sessionRef.current;
    const db = dbRef.current;
    if (timerRef.current) clearInterval(timerRef.current);

    if (session && phase === 'recording') {
      addLog('Stopping recording...', 'yellow');
      try {
        const summary = await session.stopRecording();
        addLog(`Ride #${summary.rideId} saved to SQLite`, 'green');
        addLog(`Duration: ${formatDuration(summary.durationMs)}`, 'white');
        addLog(`Samples: ${summary.sampleCount}`, 'white');
        if (summary.avgHr) addLog(`Avg HR: ${Math.round(summary.avgHr)} bpm`, 'white');
        if (summary.avgPowerW) addLog(`Avg Power: ${Math.round(summary.avgPowerW)} W`, 'white');
        if (summary.avgSpeed) addLog(`Avg Speed: ${summary.avgSpeed.toFixed(1)} km/h`, 'white');
      } catch (err) {
        addLog(`Error stopping: ${(err as Error).message}`, 'red');
      }
    }

    if (session) await session.shutdown();
    db?.close();

    addLog('Done. Goodbye!', 'cyan');
    setPhase('done');

    setTimeout(() => {
      exit();
      process.exit(0);
    }, 500);
  }, [phase, addLog, exit]);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      shutdown();
    }
  });

  // ── Status text ──

  const phaseText =
    phase === 'scanning' ? 'Scanning...' :
    phase === 'recording' ? `Recording #${rideId ?? '?'}` :
    phase === 'stopping' ? 'Stopping...' :
    'Done';

  const phaseColor =
    phase === 'scanning' ? 'yellow' :
    phase === 'recording' ? 'green' :
    phase === 'stopping' ? 'yellow' :
    'gray';

  return (
    <Box flexDirection="column">
      <LogView lines={logLines} />
      <Box borderStyle="double" borderColor="cyan" paddingX={2} justifyContent="center">
        <Text bold color="cyan">littleCycling Recorder</Text>
      </Box>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} gap={3}>
        <Box gap={1}>
          <Text bold color="white">Status</Text>
          <Text color={phaseColor}>{phaseText}</Text>
        </Box>
        {phase === 'recording' && (
          <Box gap={1}>
            <Text bold color="white">Elapsed</Text>
            <Text color="cyan">{elapsed}</Text>
          </Box>
        )}
        <Box gap={1}>
          <Text bold color="white">Sensors</Text>
          <Text color={sensorCount > 0 ? 'green' : 'gray'}>{sensorCount}</Text>
        </Box>
        <Box gap={1}>
          <Text bold color="white">DB</Text>
          <Text dimColor>{dbPath}</Text>
        </Box>
      </Box>
      <SensorBar data={sensorData} />
      <Box paddingX={1}>
        <Text dimColor color="gray">Press </Text>
        <Text bold color="white">Ctrl+C</Text>
        <Text dimColor color="gray"> to stop recording</Text>
      </Box>
    </Box>
  );
}

// ── Start ──
render(<RecorderApp />, { exitOnCtrlC: false });
