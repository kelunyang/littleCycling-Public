import React from 'react';
import { Box, Text } from 'ink';

export interface LogEntry {
  time: string;
  message: string;
  color?: string;
}

interface SensorLogProps {
  entries: LogEntry[];
  maxLines?: number;
}

export function SensorLog({ entries, maxLines = 6 }: SensorLogProps) {
  const visible = entries.slice(-maxLines);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="gray" dimColor>--- Sensor Log ---</Text>
      {visible.length === 0 ? (
        <Text color="gray"> Waiting for data...</Text>
      ) : (
        visible.map((entry, i) => (
          <Text key={i}>
            <Text color="gray">[{entry.time}] </Text>
            <Text color={entry.color ?? 'white'}>{entry.message}</Text>
          </Text>
        ))
      )}
    </Box>
  );
}
