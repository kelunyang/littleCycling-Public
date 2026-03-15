import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

interface StatusBarProps {
  recordCount: number;
  fileName: string;
  isRecording: boolean;
}

export function StatusBar({ recordCount, fileName, isRecording }: StatusBarProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={2}>
        <Text>
          <Text color="gray">Records: </Text>
          <Text color="white" bold>{recordCount.toLocaleString()}</Text>
        </Text>
        <Text>
          <Text color="gray">File: </Text>
          <Text color="white">{fileName}</Text>
        </Text>
      </Box>
      <Box gap={2}>
        {isRecording ? (
          <Text color="green">
            <Spinner type="dots" /> RECORDING
          </Text>
        ) : (
          <Text color="yellow">STOPPED</Text>
        )}
        <Text color="gray">[q] quit and save</Text>
      </Box>
    </Box>
  );
}
