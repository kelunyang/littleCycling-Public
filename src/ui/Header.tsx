import React from 'react';
import { Box, Text } from 'ink';

export function Header() {
  return (
    <Box
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      justifyContent="center"
    >
      <Text bold color="cyan">
        littleCycling Recorder
      </Text>
    </Box>
  );
}
