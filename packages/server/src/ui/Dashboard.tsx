import React from 'react';
import { Box } from 'ink';
import { Header } from './Header.js';
import { SensorCard, hrZoneColor } from './SensorCard.js';
import { SensorLog, type LogEntry } from './SensorLog.js';
import { ProgressBar } from './ProgressBar.js';
import { StatusBar } from './StatusBar.js';

export interface SensorData {
  heartRate: number;
  speed: number;
  cadence: number;
}

interface DashboardProps {
  sensorData: SensorData;
  logEntries: LogEntry[];
  elapsedMs: number;
  targetMs: number;
  recordCount: number;
  fileName: string;
  isRecording: boolean;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function Dashboard({
  sensorData,
  logEntries,
  elapsedMs,
  targetMs,
  recordCount,
  fileName,
  isRecording,
}: DashboardProps) {
  const progress = targetMs > 0 ? elapsedMs / targetMs : 0;
  const progressLabel = `${formatDuration(elapsedMs)} / ${formatDuration(targetMs)}`;

  return (
    <Box flexDirection="column">
      <Header />

      {/* Big sensor numbers */}
      <Box justifyContent="center" gap={1} marginY={1}>
        <SensorCard
          icon="♥"
          label="Heart Rate"
          value={sensorData.heartRate > 0 ? String(sensorData.heartRate) : '--'}
          unit="bpm"
          color={hrZoneColor(sensorData.heartRate)}
        />
        <SensorCard
          icon="»"
          label="Speed"
          value={sensorData.speed > 0 ? sensorData.speed.toFixed(1) : '--'}
          unit="km/h"
          color="blueBright"
        />
        <SensorCard
          icon="~"
          label="Cadence"
          value={sensorData.cadence > 0 ? String(Math.round(sensorData.cadence)) : '--'}
          unit="rpm"
          color="magenta"
        />
      </Box>

      {/* Sensor log */}
      <SensorLog entries={logEntries} />

      {/* Progress bar */}
      <Box marginTop={1}>
        <ProgressBar progress={progress} label={progressLabel} />
      </Box>

      {/* Status bar */}
      <StatusBar
        recordCount={recordCount}
        fileName={fileName}
        isRecording={isRecording}
      />
    </Box>
  );
}
