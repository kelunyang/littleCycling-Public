import React from 'react';
import { Box, Text } from 'ink';

interface SensorCardProps {
  label: string;
  value: string;
  unit: string;
  color?: string;
  icon?: string;
}

export function SensorCard({ label, value, unit, color = 'white', icon = '' }: SensorCardProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      alignItems="center"
      paddingX={3}
      paddingY={0}
      minWidth={18}
    >
      <Text color="gray">{icon}{icon ? ' ' : ''}{label}</Text>
      <Text bold color={color} >
        {value}
      </Text>
      <Text color="gray">{unit}</Text>
    </Box>
  );
}

/** Pick a color for heart rate based on zone */
export function hrZoneColor(hr: number): string {
  if (hr <= 0) return 'gray';
  if (hr < 120) return 'green';       // Zone 1-2
  if (hr < 145) return 'yellow';      // Zone 3
  if (hr < 165) return 'redBright';   // Zone 4
  return 'red';                        // Zone 5
}
