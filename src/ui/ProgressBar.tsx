import React from 'react';
import { Box, Text } from 'ink';

interface ProgressBarProps {
  /** 0.0 to 1.0 */
  progress: number;
  /** e.g. "15:42 / 30:00" */
  label: string;
  width?: number;
}

export function ProgressBar({ progress, label, width = 40 }: ProgressBarProps) {
  const clamped = Math.min(1, Math.max(0, progress));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  let barColor = 'green';
  if (clamped > 0.75) barColor = 'yellow';
  if (clamped > 0.95) barColor = 'red';

  return (
    <Box paddingX={1}>
      <Text color={barColor}>{bar}</Text>
      <Text color="white"> {label}</Text>
    </Box>
  );
}
