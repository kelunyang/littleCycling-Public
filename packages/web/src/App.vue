<template>
  <router-view />
</template>

<style>
:root {
  /* ── Cyberpunk 2077 palette ── */
  --hud-bg: rgba(5, 10, 20, 0.82);
  --hud-bg-light: rgba(10, 18, 32, 0.7);
  --hud-text: #8ec8e8;
  --hud-text-bright: #e0f4ff;
  --hud-cyan: #00e5ff;
  --hud-yellow: #fcee09;
  --hud-magenta: #ff2d6b;
  --hud-glow-cyan: 0 0 6px rgba(0, 229, 255, 0.5), 0 0 20px rgba(0, 229, 255, 0.15);
  --hud-glow-yellow: 0 0 6px rgba(252, 238, 9, 0.5), 0 0 20px rgba(252, 238, 9, 0.15);
  --hud-glow-magenta: 0 0 6px rgba(255, 45, 107, 0.5), 0 0 20px rgba(255, 45, 107, 0.15);
  --hud-border: rgba(0, 229, 255, 0.25);
  --hud-border-bright: rgba(0, 229, 255, 0.5);

  /* Zones — neon-ified */
  --zone-1: #6e7a8a;
  --zone-2: #00b4ff;
  --zone-3: #00ff88;
  --zone-4: #ffaa00;
  --zone-5: #ff2d6b;

  /* Accents */
  --accent-coin: #fcee09;
  --accent-primary: #00e5ff;
  --accent-danger: #ff2d6b;
  --surface: #0a0e1a;
  --surface-light: #111828;
  --border: rgba(0, 229, 255, 0.2);

  /* Fonts */
  --font-display: 'Orbitron', monospace, sans-serif;
  --font-body: 'Rajdhani', 'Segoe UI', system-ui, sans-serif;

  /* Clip-path for angled corners */
  --clip-panel: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
  --clip-panel-sm: polygon(0 0, calc(100% - 5px) 0, 100% 5px, 100% 100%, 5px 100%, 0 calc(100% - 5px));
  --clip-panel-lg: polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px));

  /* Strong glow for panels */
  --hud-glow-cyan-strong: 0 0 8px rgba(0,229,255,0.6), 0 0 30px rgba(0,229,255,0.2), inset 0 0 30px rgba(0,229,255,0.03);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: var(--font-body);
  background: #050810;
  color: var(--hud-text);
  overflow: hidden;
  width: 100vw;
  height: 100vh;
}

#app {
  width: 100%;
  height: 100%;
}

@keyframes glitch-flicker {
  0%, 100% { opacity: 1; transform: translate(0); }
  7%  { opacity: 0.85; transform: translate(-2px, 1px); filter: hue-rotate(20deg); }
  10% { opacity: 1; transform: translate(0); filter: none; }
  27% { opacity: 0.9; transform: translate(1px, -1px); }
  30% { opacity: 1; transform: translate(0); }
  55% { opacity: 0.75; transform: translate(-1px, 0); filter: hue-rotate(-10deg); }
  57% { opacity: 1; transform: translate(0); filter: none; }
}

@keyframes scanline-drift {
  from { background-position: 0 0; }
  to   { background-position: 0 200px; }
}

@keyframes neon-pulse-border {
  0%, 100% { filter: drop-shadow(0 0 6px rgba(0,229,255,0.4)) drop-shadow(0 0 20px rgba(0,229,255,0.15)); }
  50%      { filter: drop-shadow(0 0 12px rgba(0,229,255,0.7)) drop-shadow(0 0 40px rgba(0,229,255,0.3)); }
}

html.dark {
  --el-bg-color: var(--surface);
  --el-bg-color-overlay: var(--surface-light);
  --el-text-color-primary: var(--hud-text-bright);
  --el-text-color-regular: var(--hud-text);
  --el-border-color: var(--border);
  --el-border-color-light: var(--border);
  --el-color-primary: var(--accent-primary);
  --el-color-danger: var(--accent-danger);
  --el-color-success: #00ff88;
  --el-fill-color-blank: var(--surface-light);
  --el-fill-color-light: var(--surface);
}
</style>
