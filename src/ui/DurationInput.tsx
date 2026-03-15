import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface RideSettings {
  minutes: number;
  wheelCircumference: number; // in meters, e.g. 2.105
}

interface DurationInputProps {
  onSubmit: (settings: RideSettings) => void;
}

const DURATION_PRESETS = [15, 30, 45, 60, 90];

const WHEEL_PRESETS = [
  { label: '700x23c', value: 2.096 },
  { label: '700x25c', value: 2.105 },
  { label: '700x28c', value: 2.136 },
  { label: '700x32c', value: 2.155 },
  { label: '700x35c', value: 2.168 },
];

type Field = 'duration' | 'wheel';

export function DurationInput({ onSubmit }: DurationInputProps) {
  const [field, setField] = useState<Field>('duration');
  const [durationIndex, setDurationIndex] = useState(1); // default 30 min
  const [wheelIndex, setWheelIndex] = useState(1); // default 700x25c

  useInput((_input, key) => {
    if (key.upArrow || key.downArrow) {
      setField((f) => (f === 'duration' ? 'wheel' : 'duration'));
    }
    if (key.leftArrow) {
      if (field === 'duration') {
        setDurationIndex((i) => Math.max(0, i - 1));
      } else {
        setWheelIndex((i) => Math.max(0, i - 1));
      }
    }
    if (key.rightArrow) {
      if (field === 'duration') {
        setDurationIndex((i) => Math.min(DURATION_PRESETS.length - 1, i + 1));
      } else {
        setWheelIndex((i) => Math.min(WHEEL_PRESETS.length - 1, i + 1));
      }
    }
    if (key.return) {
      onSubmit({
        minutes: DURATION_PRESETS[durationIndex]!,
        wheelCircumference: WHEEL_PRESETS[wheelIndex]!.value,
      });
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} alignItems="center">
      <Text bold color="cyan">Ride Settings</Text>
      <Text color="gray">Up/Down to switch field, Left/Right to adjust, Enter to start</Text>

      {/* Duration */}
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text bold color={field === 'duration' ? 'cyan' : 'gray'}>
          {field === 'duration' ? '> ' : '  '}Duration
        </Text>
        <Box gap={1}>
          {DURATION_PRESETS.map((mins, i) => {
            const active = field === 'duration';
            const selected = i === durationIndex;
            return (
              <Box
                key={mins}
                borderStyle={selected ? 'bold' : 'single'}
                borderColor={selected && active ? 'cyan' : selected ? 'white' : 'gray'}
                paddingX={2}
              >
                <Text bold={selected} color={selected && active ? 'cyan' : selected ? 'white' : 'gray'}>
                  {mins} min
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Wheel circumference */}
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text bold color={field === 'wheel' ? 'cyan' : 'gray'}>
          {field === 'wheel' ? '> ' : '  '}Wheel Size
        </Text>
        <Box gap={1}>
          {WHEEL_PRESETS.map((w, i) => {
            const active = field === 'wheel';
            const selected = i === wheelIndex;
            return (
              <Box
                key={w.label}
                borderStyle={selected ? 'bold' : 'single'}
                borderColor={selected && active ? 'cyan' : selected ? 'white' : 'gray'}
                paddingX={1}
              >
                <Text bold={selected} color={selected && active ? 'cyan' : selected ? 'white' : 'gray'}>
                  {w.label} ({(w.value * 1000).toFixed(0)}mm)
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
