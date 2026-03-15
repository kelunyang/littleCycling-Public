#!/usr/bin/env node
/**
 * littleCycling - Sensor Recorder with Ink UI
 *
 * Usage:
 *   npx tsx src/cli.tsx              # ANT+ + BLE heart rate (default)
 *   npx tsx src/cli.tsx --no-ble-hr  # ANT+ only, skip BLE scanning
 *   npx tsx src/cli.tsx --debug      # Enable debug logging
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, useApp, useInput, Box, Text } from 'ink';
import path from 'node:path';

import { AntConnection } from './lib/ant-connection.js';
import { SensorManager, type DetectedSensor } from './lib/sensor-manager.js';
import { DataWriter } from './lib/data-writer.js';
import { BleConnection, type BleHrDevice, type BleHrData } from './lib/ble-connection.js';

import { DurationInput } from './ui/DurationInput.js';
import { ScanView } from './ui/ScanView.js';
import { Dashboard, type SensorData } from './ui/Dashboard.js';
import { Header } from './ui/Header.js';
import type { LogEntry } from './ui/SensorLog.js';

// ── CLI flags ──
const args = process.argv.slice(2);
const debug = args.includes('--debug');
const useBleHr = !args.includes('--no-ble-hr');

const defaultFilename = `recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`;
const outputPath = path.resolve('recordings', defaultFilename);
const outputFileName = path.basename(outputPath);

// ── App phases ──
type Phase = 'duration' | 'connecting' | 'scanning' | 'recording' | 'saving' | 'done' | 'error';

/** Normalize BLE HR data to match ANT+ HR field names for JSONL compatibility. */
function normalizeBleHrData(data: BleHrData): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ComputedHeartRate: data.heartRate,
    source: 'ble',
  };
  if (data.contactDetected !== undefined) {
    normalized.ContactDetected = data.contactDetected;
  }
  if (data.rrIntervals && data.rrIntervals.length > 0) {
    normalized.RRInterval = data.rrIntervals;
  }
  return normalized;
}

function App() {
  const { exit } = useApp();

  const [phase, setPhase] = useState<Phase>('duration');
  const [targetMinutes, setTargetMinutes] = useState(30);
  const [scanStatus, setScanStatus] = useState('Connecting...');
  const [foundSensors, setFoundSensors] = useState<DetectedSensor[]>([]);
  const [selectedSensorIds, setSelectedSensorIds] = useState<Set<string>>(new Set());
  const [scanCursor, setScanCursor] = useState(0);
  const [sensorData, setSensorData] = useState<SensorData>({ heartRate: 0, speed: 0, cadence: 0 });
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [recordCount, setRecordCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  // Refs to persist across renders without causing re-renders
  const connectionRef = useRef<AntConnection | null>(null);
  const sensorMgrRef = useRef<SensorManager | null>(null);
  const writerRef = useRef<DataWriter | null>(null);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isShuttingDownRef = useRef(false);
  const lastLogTimeRef = useRef<Record<string, number>>({});
  // Track raw sensor event times to detect stale values the library doesn't zero out
  const lastRawRef = useRef<{
    cadenceEventTime?: number;
    cadenceStaleAt?: number;
    speedEventTime?: number;
    speedStaleAt?: number;
  }>({});
  // Ref mirror for selectedSensorIds — needed because handleDurationSelected's
  // closure captures state at creation time, but we read it after await resumes
  const selectedSensorIdsRef = useRef<Set<string>>(new Set());

  // Keep stickInfo in a ref so recording setup can access it
  const stickInfoRef = useRef<{ maxChannels: number } | null>(null);

  // BLE refs
  const bleRef = useRef<BleConnection | null>(null);
  const bleDevicesRef = useRef<Map<number, BleHrDevice>>(new Map());
  // Manual scan-phase resolve for BLE-only mode (no ANT+ scanner to await)
  const scanResolveRef = useRef<(() => void) | null>(null);

  // Helper: add log entry
  const addLog = useCallback((message: string, color?: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogEntries((prev) => [...prev.slice(-50), { time, message, color }]);
  }, []);

  // Helper: format profile name for display
  const profileName = (p: string) => {
    if (p === 'HR') return 'Heart Rate';
    if (p === 'SC') return 'Speed/Cadence';
    if (p === 'SPD') return 'Speed';
    if (p === 'CAD') return 'Cadence';
    return p;
  };

  // Keep selectedSensorIds ref in sync with state
  useEffect(() => {
    selectedSensorIdsRef.current = selectedSensorIds;
  }, [selectedSensorIds]);

  // Wheel circumference from settings screen
  const wheelCircRef = useRef(2.105);

  // ── Phase: Duration selected → connect + scan + record ──
  const handleDurationSelected = useCallback(async (settings: { minutes: number; wheelCircumference: number }) => {
    const { minutes, wheelCircumference } = settings;
    setTargetMinutes(minutes);
    wheelCircRef.current = wheelCircumference;
    setPhase('connecting');
    setScanStatus('Connecting...');

    try {
      // ── ANT+ stick (optional when --ble-hr) ──
      let antOk = false;
      const connection = new AntConnection({ startupTimeout: 10000, debug });
      connectionRef.current = connection;

      try {
        const stickInfo = await connection.open();
        stickInfoRef.current = stickInfo;
        addLog(`ANT+ stick connected (${stickInfo.maxChannels} channels)`, 'green');
        antOk = true;
      } catch (err: any) {
        if (useBleHr) {
          addLog(`ANT+ stick not found — BLE HR only`, 'yellow');
          connectionRef.current = null;
        } else {
          throw err;
        }
      }

      // ── BLE adapter ──
      if (useBleHr) {
        try {
          const ble = new BleConnection({ scanTimeout: 120000, debug });
          bleRef.current = ble;
          await ble.waitForAdapter();
          addLog('BLE adapter ready', 'green');
        } catch (err: any) {
          addLog(`BLE adapter error: ${err.message}`, 'red');
          bleRef.current = null;
          if (!antOk) {
            throw new Error('No ANT+ stick and no BLE adapter available.');
          }
        }
      }

      if (!antOk && !bleRef.current) {
        throw new Error('No sensor connections available.');
      }

      // ── Scanning phase ──
      setPhase('scanning');
      setScanStatus('Scanning for sensors... Spin your wheel & wear HR strap!');

      // Start ANT+ scanning (non-blocking promise — resolves on finishScanPhase)
      let antScanPromise: Promise<void> | null = null;
      let scanChannel: any = null;
      if (antOk && connectionRef.current) {
        const channel = connectionRef.current.getChannel();
        scanChannel = channel;
        const sensorMgr = new SensorManager(channel, {
          debug,
          wheelCircumference,
          onDetect: (sensor) => {
            setFoundSensors((prev) => [...prev, sensor]);
            const key = `${sensor.profile}-${sensor.deviceId}`;
            setSelectedSensorIds((prev) => new Set(prev).add(key));
            addLog(`ANT+ ${profileName(sensor.profile)} (ID: ${sensor.deviceId})`, 'green');
          },
          onData: () => {},
        });
        sensorMgrRef.current = sensorMgr;
        antScanPromise = sensorMgr.startScanning();
      }

      // Start BLE scanning concurrently
      if (bleRef.current) {
        bleRef.current.scan((device) => {
          // Use negative IDs for BLE devices to distinguish from ANT+
          const bleId = -(bleDevicesRef.current.size + 1);
          bleDevicesRef.current.set(bleId, device);
          const sensor: DetectedSensor = { profile: 'HR', deviceId: bleId };
          setFoundSensors((prev) => [...prev, sensor]);
          const key = `HR-${bleId}`;
          setSelectedSensorIds((prev) => new Set(prev).add(key));
          addLog(`BLE HR: ${device.name}`, 'green');
          // Auto-stop BLE scan after first device found
          bleRef.current?.stopScan();
        }).catch((err: any) => {
          addLog(`BLE scan error: ${err.message}`, 'red');
        });
      }

      // Block until user presses Enter
      if (antScanPromise) {
        await antScanPromise;
      } else {
        // BLE-only mode: wait for Enter via manual resolve
        await new Promise<void>((resolve) => {
          scanResolveRef.current = resolve;
        });
      }

      // ── Scanning stopped (Enter pressed) ──
      const currentSelected = selectedSensorIdsRef.current;
      const allSensors = sensorMgrRef.current?.getDetectedSensors() ?? [];
      const antSensors = allSensors.filter((s) => currentSelected.has(`${s.profile}-${s.deviceId}`));

      // Find selected BLE devices
      const selectedBleDevices: Array<{ bleId: number; device: BleHrDevice }> = [];
      for (const [bleId, device] of bleDevicesRef.current.entries()) {
        if (currentSelected.has(`HR-${bleId}`)) {
          selectedBleDevices.push({ bleId, device });
        }
      }

      if (antSensors.length === 0 && selectedBleDevices.length === 0) {
        setErrorMessage('No sensors selected. Make sure sensors are active and selected.');
        setPhase('error');
        if (connectionRef.current) await connectionRef.current.close();
        return;
      }

      // ── Start recording ──
      const writer = new DataWriter(outputPath);
      writer.open();

      const sensorList = [
        ...antSensors.map((s) => ({ profile: s.profile, deviceId: s.deviceId })),
        ...selectedBleDevices.map((b) => ({ profile: 'HR', deviceId: 0, source: 'ble', name: b.device.name })),
      ];
      writer.writeSessionStart(
        { maxChannels: stickInfoRef.current?.maxChannels ?? 0 },
        sensorList
      );
      writerRef.current = writer;

      // Build a set of selected ANT+ sensor keys for fast lookup during recording
      const selectedKeys = new Set(antSensors.map((s) => `${s.profile}-${s.deviceId}`));

      // Hook ANT+ data events on the scanner channel (same channel used for scanning)
      if (scanChannel) {
        scanChannel.on('data', (profile: string, deviceId: number, data: any) => {
          if (!selectedKeys.has(`${profile}-${deviceId}`)) return;

          // Normalize RRInterval to always be an array (ANT+ sends a single number)
          const normalized = { ...data, source: 'ant' };
          if (normalized.RRInterval != null && !Array.isArray(normalized.RRInterval)) {
            normalized.RRInterval = [normalized.RRInterval];
          }
          writer.writeData(profile, deviceId, normalized);
          setRecordCount(writer.recordCount);

          // Update live sensor display
          const now = Date.now();
          const raw = lastRawRef.current;
          const STALE_MS = 1000;

          if (profile === 'HR' && data.ComputedHeartRate != null) {
            setSensorData((prev) => ({ ...prev, heartRate: data.ComputedHeartRate }));
          }

          if (data.CadenceEventTime != null) {
            if (raw.cadenceEventTime !== data.CadenceEventTime) {
              raw.cadenceEventTime = data.CadenceEventTime;
              raw.cadenceStaleAt = undefined;
              if (data.CalculatedCadence != null && data.CalculatedCadence > 0) {
                setSensorData((prev) => ({ ...prev, cadence: data.CalculatedCadence }));
              }
            } else {
              if (!raw.cadenceStaleAt) {
                raw.cadenceStaleAt = now;
              } else if (now - raw.cadenceStaleAt >= STALE_MS) {
                setSensorData((prev) => ({ ...prev, cadence: 0 }));
              }
            }
          }

          if (data.SpeedEventTime != null) {
            if (raw.speedEventTime !== data.SpeedEventTime) {
              raw.speedEventTime = data.SpeedEventTime;
              raw.speedStaleAt = undefined;
              if (data.CalculatedSpeed != null && data.CalculatedSpeed > 0) {
                setSensorData((prev) => ({ ...prev, speed: data.CalculatedSpeed * 3.6 }));
              }
            } else {
              if (!raw.speedStaleAt) {
                raw.speedStaleAt = now;
              } else if (now - raw.speedStaleAt >= STALE_MS) {
                setSensorData((prev) => ({ ...prev, speed: 0 }));
              }
            }
          }

          // Log entry (throttled)
          const logKey = `${profile}-${deviceId}`;
          const lastTime = lastLogTimeRef.current[logKey] ?? 0;
          if (now - lastTime > 2000) {
            lastLogTimeRef.current[logKey] = now;
            if (profile === 'HR') {
              addLog(`HR #${deviceId}: ${data.ComputedHeartRate ?? '--'} bpm`);
            } else {
              const spd = data.CalculatedSpeed != null ? `${data.CalculatedSpeed.toFixed(1)} km/h` : '--';
              const cad = data.CalculatedCadence != null ? `${Math.round(data.CalculatedCadence)} rpm` : '--';
              addLog(`${profile} #${deviceId}: ${spd}, ${cad}`);
            }
          }
        });
      }

      // Connect BLE HR devices in background (don't block recording start)
      for (const { device } of selectedBleDevices) {
        if (!bleRef.current) break;
        const ble = bleRef.current;
        addLog(`BLE HR connecting: ${device.name}...`, 'yellow');
        ble.connect(
          device,
          (data: BleHrData) => {
            writer.writeData('HR', 0, normalizeBleHrData(data));
            setRecordCount(writer.recordCount);
            setSensorData((prev) => ({ ...prev, heartRate: data.heartRate }));

            // Throttled log
            const now = Date.now();
            const logKey = 'ble-hr';
            const lastTime = lastLogTimeRef.current[logKey] ?? 0;
            if (now - lastTime > 2000) {
              lastLogTimeRef.current[logKey] = now;
              addLog(`BLE HR: ${data.heartRate} bpm`);
            }
          },
          () => {
            addLog(`BLE HR disconnected: ${device.name}`, 'yellow');
          }
        ).then(() => {
          addLog(`BLE HR connected: ${device.name}`, 'green');
        }).catch((err: any) => {
          addLog(`BLE HR connection failed: ${err.message}`, 'red');
        });
      }

      // Start elapsed timer
      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        setElapsedMs(elapsed);

        // Auto-stop when target duration reached
        const targetMs = minutes * 60 * 1000;
        if (elapsed >= targetMs && !isShuttingDownRef.current) {
          shutdown();
        }
      }, 500);

      addLog(`Recording started! Target: ${minutes} min`, 'cyan');
      setPhase('recording');
    } catch (err: any) {
      setErrorMessage(err.message ?? String(err));
      setPhase('error');
    }
  }, [addLog]);

  // ── Shutdown ──
  const shutdown = useCallback(async () => {
    if (isShuttingDownRef.current) return;
    isShuttingDownRef.current = true;

    setPhase('saving');
    if (timerRef.current) clearInterval(timerRef.current);

    try {
      sensorMgrRef.current?.stopScanning();
      if (bleRef.current) {
        await bleRef.current.disconnect();
      }
      if (writerRef.current) {
        await writerRef.current.close();
        addLog(`Saved: ${outputPath} (${writerRef.current.recordCount} records)`, 'green');
      }
      await connectionRef.current?.close();
    } catch {
      // Best effort cleanup
    }

    setPhase('done');
    setTimeout(() => exit(), 1500);
  }, [exit, addLog]);

  // ── Keyboard ──
  useInput((input, key) => {
    if (phase === 'scanning') {
      if (key.upArrow) {
        setScanCursor((i) => Math.max(0, i - 1));
      }
      if (key.downArrow) {
        setScanCursor((i) => Math.min(foundSensors.length - 1, i));
      }
      if (input === ' ' && foundSensors.length > 0) {
        const sensor = foundSensors[scanCursor];
        if (sensor) {
          const sensorKey = `${sensor.profile}-${sensor.deviceId}`;
          setSelectedSensorIds((prev) => {
            const next = new Set(prev);
            if (next.has(sensorKey)) {
              next.delete(sensorKey);
            } else {
              next.add(sensorKey);
            }
            return next;
          });
        }
      }
      if (key.return && foundSensors.length > 0) {
        // Stop BLE scan if running
        bleRef.current?.stopScan();
        // Finish ANT+ scan phase (scanner channel stays open)
        sensorMgrRef.current?.finishScanPhase();
        // Resolve manual scan promise (BLE-only mode)
        if (scanResolveRef.current) {
          scanResolveRef.current();
          scanResolveRef.current = null;
        }
      }
    }
    if ((input === 'q' || (input === 'c' && key.ctrl)) && phase !== 'duration' && phase !== 'done') {
      shutdown();
    }
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ── Render by phase ──

  if (phase === 'duration') {
    return (
      <Box flexDirection="column">
        <Header />
        <DurationInput onSubmit={handleDurationSelected} />
      </Box>
    );
  }

  if (phase === 'connecting' || phase === 'scanning') {
    return (
      <Box flexDirection="column">
        <Header />
        <ScanView
          status={scanStatus}
          foundSensors={foundSensors}
          selectedIds={selectedSensorIds}
          cursorIndex={scanCursor}
          bleDevices={bleDevicesRef.current}
        />
      </Box>
    );
  }

  if (phase === 'recording') {
    return (
      <Dashboard
        sensorData={sensorData}
        logEntries={logEntries}
        elapsedMs={elapsedMs}
        targetMs={targetMinutes * 60 * 1000}
        recordCount={recordCount}
        fileName={outputFileName}
        isRecording={true}
      />
    );
  }

  if (phase === 'saving') {
    return (
      <Box flexDirection="column">
        <Header />
        <Box paddingX={1} paddingY={1}>
          <Text color="yellow">Saving recording and closing connections...</Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'done') {
    return (
      <Box flexDirection="column">
        <Header />
        <Box paddingX={1} paddingY={1} flexDirection="column">
          <Text color="green" bold>Recording complete!</Text>
          <Text>File: {outputPath}</Text>
          <Text>Records: {writerRef.current?.recordCount.toLocaleString() ?? recordCount.toLocaleString()}</Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'error') {
    return (
      <Box flexDirection="column">
        <Header />
        <Box paddingX={1} paddingY={1} flexDirection="column">
          <Text color="red" bold>Error:</Text>
          <Text color="red">{errorMessage}</Text>
          <Text color="gray" dimColor>Press Ctrl+C to exit</Text>
        </Box>
      </Box>
    );
  }

  return null;
}

// ── Start ──
render(<App />, { exitOnCtrlC: false });
