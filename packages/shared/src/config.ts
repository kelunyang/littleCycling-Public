/**
 * Application config type definition and defaults.
 * Persisted in data/config.json, editable via the settings page.
 */

export interface AppConfig {
  sensor: {
    wheelCircumference: number;  // meters
    trainerModel: string;        // key in POWER_CURVES
  };
  training: {
    defaultDuration: number;     // ms
    hrMax: number;               // bpm
    ftp: number;                 // watts
  };
  server: {
    wsPort: number;
  };
  map: {
    basemapStyle: string;
    renderMode: 'maplibre' | 'threejs' | 'phaser';
    phaserStyle: 'plastic' | 'cuphead'; // 2D visual style (only for phaser mode)
    cameraHeight: number;    // 1-30m, camera height above ground
    cameraPitch: number;     // 1-60°, downward pitch angle
    cameraLookAhead: number; // 10-200m, look-ahead distance
    viewRange: number;       // 100-1000, corridor half-width in meters
    dayNightEnabled: boolean; // real-time day/night cycle based on route location
  };
  sound: {
    enabled: boolean;  // master sound on/off toggle
  };
  debug: boolean; // enable verbose console logging for terrain, MVT, weather, etc.
}

export const DEFAULT_CONFIG: AppConfig = {
  sensor: {
    wheelCircumference: 2.105,
    trainerModel: 'generic-fluid',
  },
  training: {
    defaultDuration: 30 * 60 * 1000, // 30 minutes
    hrMax: 190,
    ftp: 200,
  },
  server: {
    wsPort: 8765,
  },
  map: {
    basemapStyle: 'liberty',
    renderMode: 'threejs',
    phaserStyle: 'plastic',
    cameraHeight: 15,
    cameraPitch: 12,
    cameraLookAhead: 80,
    viewRange: 500,
    dayNightEnabled: true,
  },
  sound: {
    enabled: true,
  },
  debug: false,
};
