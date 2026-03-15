import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import dayjs from 'dayjs';

export interface ReplaySettings {
  filePath: string;
  speed: number;
  loop: boolean;
}

interface ReplaySetupProps {
  defaultDir: string;
  onSubmit: (settings: ReplaySettings) => void;
}

interface JsonlFile {
  name: string;
  path: string;
  sizeKB: number;
  mtime: Date;
}

const SPEED_PRESETS = [0.5, 1, 2, 4, 8];

type Field = 'file' | 'speed' | 'loop';
const FIELDS: Field[] = ['file', 'speed', 'loop'];

function scanJsonlFiles(dir: string): JsonlFile[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((name) => {
        const fullPath = resolve(dir, name);
        const stat = statSync(fullPath);
        return {
          name,
          path: fullPath,
          sizeKB: Math.round(stat.size / 1024),
          mtime: stat.mtime,
        };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime()); // newest first
  } catch {
    return [];
  }
}

export function ReplaySetup({ defaultDir, onSubmit }: ReplaySetupProps) {
  const [files, setFiles] = useState<JsonlFile[]>([]);
  const [field, setField] = useState<Field>('file');
  const [fileIndex, setFileIndex] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(1); // default 1x
  const [loop, setLoop] = useState(false);

  useEffect(() => {
    setFiles(scanJsonlFiles(defaultDir));
  }, [defaultDir]);

  useInput((_input, key) => {
    const fieldIdx = FIELDS.indexOf(field);

    if (field === 'file') {
      // In file list: up/down navigates files, tab/down-at-bottom goes to next field
      if (key.upArrow) {
        setFileIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        if (fileIndex < files.length - 1) {
          setFileIndex((i) => i + 1);
        } else {
          // At bottom of file list, move to next field
          setField(FIELDS[fieldIdx + 1]!);
        }
        return;
      }
      if (key.tab) {
        setField(FIELDS[fieldIdx + 1] ?? FIELDS[0]!);
        return;
      }
    } else {
      // In speed/loop fields: up/down switches field
      if (key.upArrow) {
        if (fieldIdx > 0) {
          const prev = FIELDS[fieldIdx - 1]!;
          if (prev === 'file') {
            setField('file');
            // cursor stays at current fileIndex
          } else {
            setField(prev);
          }
        }
        return;
      }
      if (key.downArrow || key.tab) {
        if (fieldIdx < FIELDS.length - 1) {
          setField(FIELDS[fieldIdx + 1]!);
        }
        return;
      }
    }

    if (key.leftArrow) {
      if (field === 'speed') {
        setSpeedIndex((i) => Math.max(0, i - 1));
      } else if (field === 'loop') {
        setLoop((v) => !v);
      }
    }
    if (key.rightArrow) {
      if (field === 'speed') {
        setSpeedIndex((i) => Math.min(SPEED_PRESETS.length - 1, i + 1));
      } else if (field === 'loop') {
        setLoop((v) => !v);
      }
    }

    if (_input === ' ' && field === 'loop') {
      setLoop((v) => !v);
    }

    if (key.return && files.length > 0) {
      onSubmit({
        filePath: files[fileIndex]!.path,
        speed: SPEED_PRESETS[speedIndex]!,
        loop,
      });
    }
  });

  const isActive = (f: Field) => f === field;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box borderStyle="double" borderColor="cyan" paddingX={2} justifyContent="center">
        <Text bold color="cyan">littleCycling Replay</Text>
      </Box>

      <Text color="gray">  Up/Down to navigate, Left/Right to adjust, Enter to start</Text>

      {/* File list */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={isActive('file') ? 'cyan' : 'gray'}>
          {isActive('file') ? '> ' : '  '}Recording File
        </Text>
        {files.length === 0 ? (
          <Box paddingLeft={4}>
            <Text color="red">No .jsonl files found in {defaultDir}</Text>
          </Box>
        ) : (
          <Box flexDirection="column" paddingLeft={2}>
            {files.map((f, i) => {
              const isCursor = isActive('file') && i === fileIndex;
              const isSelected = i === fileIndex;
              return (
                <Box key={f.name} gap={1}>
                  <Text color={isCursor ? 'cyan' : isSelected ? 'white' : 'gray'}>
                    {isCursor ? '>' : isSelected ? '*' : ' '}
                  </Text>
                  <Text bold={isSelected} color={isCursor ? 'cyan' : isSelected ? 'white' : 'gray'}>
                    {f.name}
                  </Text>
                  <Text dimColor>
                    ({f.sizeKB} KB, {dayjs(f.mtime).format('YYYY-MM-DD HH:mm')})
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Speed */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={isActive('speed') ? 'cyan' : 'gray'}>
          {isActive('speed') ? '> ' : '  '}Speed
        </Text>
        <Box gap={1} paddingLeft={2}>
          {SPEED_PRESETS.map((s, i) => {
            const active = isActive('speed');
            const selected = i === speedIndex;
            return (
              <Box
                key={s}
                borderStyle={selected ? 'bold' : 'single'}
                borderColor={selected && active ? 'cyan' : selected ? 'white' : 'gray'}
                paddingX={1}
              >
                <Text bold={selected} color={selected && active ? 'cyan' : selected ? 'white' : 'gray'}>
                  {s}x
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Loop */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color={isActive('loop') ? 'cyan' : 'gray'}>
          {isActive('loop') ? '> ' : '  '}Loop
        </Text>
        <Box gap={1} paddingLeft={2}>
          {[false, true].map((v) => {
            const active = isActive('loop');
            const selected = loop === v;
            return (
              <Box
                key={String(v)}
                borderStyle={selected ? 'bold' : 'single'}
                borderColor={selected && active ? 'cyan' : selected ? 'white' : 'gray'}
                paddingX={1}
              >
                <Text bold={selected} color={selected && active ? 'cyan' : selected ? 'white' : 'gray'}>
                  {v ? 'ON' : 'OFF'}
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
