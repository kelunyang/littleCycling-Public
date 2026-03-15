import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface ScanViewProps {
  status: string;
  foundSensors: Array<{ profile: string; deviceId: number }>;
  selectedIds: Set<string>;
  cursorIndex: number;
  /** Map of negative deviceId → BLE device info (for display) */
  bleDevices?: Map<number, { name: string }>;
}

export function ScanView({ status, foundSensors, selectedIds, cursorIndex, bleDevices }: ScanViewProps) {
  const profileName = (p: string) => {
    if (p === 'HR') return 'Heart Rate';
    if (p === 'SC') return 'Speed/Cadence';
    if (p === 'SPD') return 'Speed';
    if (p === 'CAD') return 'Cadence';
    return p;
  };

  const sensorLabel = (s: { profile: string; deviceId: number }) => {
    // BLE devices use negative IDs
    if (s.deviceId < 0 && bleDevices?.has(s.deviceId)) {
      const bleDevice = bleDevices.get(s.deviceId)!;
      return `${profileName(s.profile)} — BLE: ${bleDevice.name}`;
    }
    return `${profileName(s.profile)} (ID: ${s.deviceId})`;
  };

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> {status}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Found sensors:</Text>
        {foundSensors.length === 0 ? (
          <Text color="gray">  (none yet - spin your wheel or crank to wake sensors)</Text>
        ) : (
          foundSensors.map((s, i) => {
            const key = `${s.profile}-${s.deviceId}`;
            const checked = selectedIds.has(key);
            const isCursor = i === cursorIndex;
            return (
              <Text key={key}>
                <Text color={isCursor ? 'cyan' : 'white'}>{isCursor ? '>' : ' '} </Text>
                <Text color={checked ? 'green' : 'gray'}>[{checked ? 'x' : ' '}] </Text>
                <Text color={checked ? 'green' : 'white'} bold={isCursor}>
                  {sensorLabel(s)}
                </Text>
              </Text>
            );
          })
        )}
      </Box>

      {foundSensors.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">[Space] toggle  [Up/Down] navigate</Text>
          {selectedIds.size > 0 ? (
            <Text color="cyan" bold>Press Enter to start recording ({selectedIds.size} sensor{selectedIds.size > 1 ? 's' : ''} selected)</Text>
          ) : (
            <Text color="yellow">Select at least one sensor to start recording</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
