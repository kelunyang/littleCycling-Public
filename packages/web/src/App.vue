<template>
  <router-view />
</template>

<script setup lang="ts">
import { watchEffect, onMounted, onBeforeUnmount } from 'vue';
import { useSettingsStore } from '@/stores/settingsStore';

/** Mirror world-style onto <body> so teleported drawers/dialogs inherit the
 *  themed CSS variables alongside the welcome/game roots. */
const settingsStore = useSettingsStore();

let stop: (() => void) | null = null;
onMounted(() => {
  stop = watchEffect(() => {
    const style = settingsStore.config.map.phaserStyle ?? 'plastic';
    document.body.dataset.worldStyle = style;
  });
});

onBeforeUnmount(() => {
  stop?.();
  delete document.body.dataset.worldStyle;
});
</script>

<style>
:root {
  /* ── Cyberpunk 2077 palette (game HUD default) ── */
  --hud-bg: rgba(5, 10, 20, 0.82);
  --hud-bg-light: rgba(10, 18, 32, 0.7);
  --hud-text: #8ec8e8;
  --hud-text-bright: #e0f4ff;
  --hud-text-dim: rgba(142, 200, 232, 0.5);
  --hud-cyan: #00e5ff;
  --hud-yellow: #fcee09;
  --hud-magenta: #ff2d6b;
  --hud-glow-cyan: 0 0 6px rgba(0, 229, 255, 0.5), 0 0 20px rgba(0, 229, 255, 0.15);
  --hud-glow-yellow: 0 0 6px rgba(252, 238, 9, 0.5), 0 0 20px rgba(252, 238, 9, 0.15);
  --hud-glow-magenta: 0 0 6px rgba(255, 45, 107, 0.5), 0 0 20px rgba(255, 45, 107, 0.15);
  --hud-border: rgba(0, 229, 255, 0.25);
  --hud-border-bright: rgba(0, 229, 255, 0.5);

  /* Themable accent (rgb-only so child styles can compose alpha) */
  --accent-rgb: 0, 229, 255;
  --accent-soft: rgba(0, 229, 255, 0.05);
  --accent-tint: rgba(0, 229, 255, 0.08);
  --accent-hover: rgba(0, 229, 255, 0.15);
  --accent-strong: rgba(0, 229, 255, 0.5);
  --accent-glow-soft: 0 0 6px rgba(0, 229, 255, 0.4);
  --accent-glow-strong: 0 0 12px rgba(0, 229, 255, 0.7), 0 0 30px rgba(0, 229, 255, 0.3);

  /* Card chrome (overridable per theme) */
  --card-radius: 0;
  --card-radius-sm: 0;
  --card-clip: var(--clip-panel-lg);
  --card-clip-sm: var(--clip-panel-sm);
  --card-shadow: drop-shadow(0 0 8px rgba(0,229,255,0.4)) drop-shadow(0 0 30px rgba(0,229,255,0.15));

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
  --font-display: 'Orbitron', 'Noto Sans TC', monospace, sans-serif;
  --font-body: 'Rajdhani', 'Noto Sans TC', 'Segoe UI', system-ui, sans-serif;

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

/* ─── Plastic theme tokens (apply on any [data-world-style="plastic"] root) ─── */
[data-world-style="plastic"] {
  --hud-bg: rgba(20, 28, 60, 0.85);
  --hud-bg-light: rgba(28, 40, 80, 0.8);
  --hud-text: #2a2050;
  --hud-text-bright: #100a30;
  --hud-text-dim: rgba(42, 32, 80, 0.55);
  --hud-cyan: #ff3b8d;
  --hud-yellow: #ffea00;
  --hud-magenta: #ff3b8d;
  --hud-border: rgba(255, 59, 141, 0.4);
  --hud-border-bright: rgba(255, 59, 141, 0.85);

  --accent-rgb: 255, 59, 141;
  --accent-soft: rgba(255, 59, 141, 0.08);
  --accent-tint: rgba(255, 59, 141, 0.14);
  --accent-hover: rgba(255, 59, 141, 0.25);
  --accent-strong: rgba(255, 59, 141, 0.6);
  --accent-glow-soft: 0 4px 0 rgba(20, 10, 40, 0.18);
  --accent-glow-strong: 0 6px 0 rgba(20, 10, 40, 0.22), 0 14px 24px rgba(255, 59, 141, 0.35);

  --card-radius: 28px;
  --card-radius-sm: 14px;
  --card-shadow: drop-shadow(0 6px 0 rgba(20, 10, 40, 0.35)) drop-shadow(0 16px 32px rgba(0, 229, 255, 0.25));
  --font-display: 'Fredoka', 'Baloo 2', 'Noto Sans TC', system-ui, sans-serif;
  --font-body: 'Quicksand', 'Nunito', 'Noto Sans TC', system-ui, sans-serif;

  /* Solid surface colour — used by Element Plus drawer/dialog (background-color
     can't render gradients, so the gradient version goes on the welcome card
     directly). */
  --surface: #ffe5f1;
  --surface-light: #ffffff;
  --surface-gradient: linear-gradient(180deg, #fff7fb 0%, #ffe5f1 100%);
  --border: rgba(255, 59, 141, 0.3);

  /* Element Plus var overrides — apply same colour to drawer/dialog/popover. */
  --el-bg-color: #ffe5f1;
  --el-bg-color-overlay: #fff7fb;
  --el-bg-color-page: #ffd6e8;
  --el-text-color-primary: #100a30;
  --el-text-color-regular: #2a2050;
  --el-border-color: rgba(255, 59, 141, 0.4);
  --el-fill-color-blank: #fff7fb;
  --el-fill-color-light: #ffe5f1;

  /* Flatten cyberpunk angled chamfers; themes use border-radius instead. */
  --clip-panel: none;
  --clip-panel-sm: none;
  --clip-panel-lg: none;

  --hud-glow-cyan: 0 4px 0 rgba(20, 10, 40, 0.25);
  --hud-glow-cyan-strong: 0 4px 0 rgba(20, 10, 40, 0.25), 0 8px 16px rgba(255, 59, 141, 0.35);
}

/* ─── Cuphead theme tokens ─── */
[data-world-style="cuphead"] {
  --hud-bg: rgba(232, 220, 192, 0.95);
  --hud-bg-light: rgba(240, 228, 200, 0.92);
  --hud-text: #4a3a2a;
  --hud-text-bright: #2a2420;
  --hud-text-dim: rgba(74, 58, 42, 0.6);
  --hud-cyan: #6b7f3b;
  --hud-yellow: #c4a035;
  --hud-magenta: #a0523c;
  --hud-border: rgba(42, 36, 32, 0.55);
  --hud-border-bright: #2a2420;

  --accent-rgb: 107, 127, 59;
  --accent-soft: rgba(196, 160, 53, 0.10);
  --accent-tint: rgba(196, 160, 53, 0.18);
  --accent-hover: rgba(160, 82, 60, 0.18);
  --accent-strong: rgba(42, 36, 32, 0.55);
  --accent-glow-soft: 2px 2px 0 #2a2420;
  --accent-glow-strong: 3px 3px 0 #2a2420;

  --card-radius: 0;
  --card-radius-sm: 0;
  --card-shadow: drop-shadow(4px 4px 0 #2a2420);
  /* 'Noto Sans TC' 擋在 cursive 前：Windows 的 cursive 是標楷體 */
  --font-display: 'Cabin Sketch', 'Patrick Hand', 'Noto Sans TC', cursive;
  --font-body: 'Patrick Hand', 'Comic Sans MS', 'Noto Sans TC', cursive;

  --surface: #e8dcc0;
  --surface-light: #f0e4cc;
  --surface-gradient:
    repeating-linear-gradient(0deg, rgba(42, 36, 32, 0.02) 0 2px, transparent 2px 4px),
    radial-gradient(ellipse at 30% 20%, #efe2c2 0%, #e8dcc0 60%, #ddcfa8 100%);
  --border: rgba(42, 36, 32, 0.45);

  --el-bg-color: #e8dcc0;
  --el-bg-color-overlay: #f0e4cc;
  --el-bg-color-page: #ddcfa8;
  --el-text-color-primary: #2a2420;
  --el-text-color-regular: #4a3a2a;
  --el-border-color: rgba(42, 36, 32, 0.55);
  --el-fill-color-blank: #f0e4cc;
  --el-fill-color-light: #e8dcc0;

  --clip-panel: none;
  --clip-panel-sm: none;
  --clip-panel-lg: none;

  --hud-glow-cyan: 2px 2px 0 #2a2420;
  --hud-glow-cyan-strong: 3px 3px 0 #2a2420;
}

/* ── Theme tweaks for Element Plus segmented / radio across body
   (welcome controls + drawers/dialogs that teleport to body) ── */

[data-world-style="cuphead"] .el-segmented__item,
[data-world-style="cuphead"] .el-radio-button__inner {
  text-transform: none !important;
  letter-spacing: 0 !important;
  font-weight: 700 !important;
  font-size: 14px !important;
}

[data-world-style="plastic"] .el-segmented__item,
[data-world-style="plastic"] .el-radio-button__inner {
  font-size: 13px !important;
}

/* el-input-number themed for both palettes */
[data-world-style="cuphead"] .el-input-number {
  border: 2px solid #2a2420 !important;
  background: rgba(232, 220, 192, 0.6) !important;
  box-shadow: 2px 2px 0 #2a2420 !important;
}

[data-world-style="cuphead"] .el-input-number .el-input__inner {
  color: #2a2420 !important;
  font-family: 'Cabin Sketch', 'Noto Sans TC', cursive !important;
}

[data-world-style="cuphead"] .el-input-number__decrease,
[data-world-style="cuphead"] .el-input-number__increase {
  background: #c4a035 !important;
  color: #2a2420 !important;
  border-color: #2a2420 !important;
}

[data-world-style="cuphead"] .el-input-number__decrease:hover,
[data-world-style="cuphead"] .el-input-number__increase:hover {
  background: #a0523c !important;
  color: #f0e4cc !important;
}

[data-world-style="plastic"] .el-input-number {
  border: 2px solid #1a1140 !important;
  background: linear-gradient(180deg, #ffffff 0%, #ffe5f1 100%) !important;
  box-shadow: 0 3px 0 #1a1140 !important;
  border-radius: 14px !important;
}

[data-world-style="plastic"] .el-input-number .el-input__inner {
  color: #1a1140 !important;
  font-family: 'Fredoka', 'Noto Sans TC', sans-serif !important;
}

[data-world-style="plastic"] .el-input-number__decrease,
[data-world-style="plastic"] .el-input-number__increase {
  background: linear-gradient(180deg, #00e5ff 0%, #00b4d8 100%) !important;
  color: #ffffff !important;
  border-color: #1a1140 !important;
}

[data-world-style="plastic"] .el-input-number__decrease:hover,
[data-world-style="plastic"] .el-input-number__increase:hover {
  background: linear-gradient(180deg, #ff3b8d 0%, #d500f9 100%) !important;
  color: #ffffff !important;
}

/* ─── Element Plus drawer + dialog backgrounds (teleported to body) ─── */

[data-world-style="plastic"] .el-drawer,
[data-world-style="plastic"] .el-dialog {
  background:
    radial-gradient(ellipse at 30% 0%, #fff7fb 0%, #ffe5f1 70%, #ffd6e8 100%) !important;
  color: #100a30 !important;
  border: 3px solid #1a1140 !important;
  box-shadow: 0 8px 0 #1a1140, 0 16px 32px rgba(255, 59, 141, 0.45) !important;
}

[data-world-style="plastic"] .el-drawer__header,
[data-world-style="plastic"] .el-dialog__header {
  color: #ff3b8d !important;
  border-bottom: 2px dashed rgba(26, 17, 64, 0.3) !important;
  padding-bottom: 12px;
  font-family: 'Fredoka', 'Noto Sans TC', sans-serif !important;
  font-weight: 700 !important;
}

[data-world-style="plastic"] .el-drawer__title,
[data-world-style="plastic"] .el-dialog__title {
  color: #1a1140 !important;
  font-family: 'Fredoka', 'Noto Sans TC', sans-serif !important;
  font-weight: 700 !important;
}

[data-world-style="plastic"] .el-drawer__close-btn,
[data-world-style="plastic"] .el-dialog__headerbtn .el-dialog__close {
  color: #1a1140 !important;
}

[data-world-style="cuphead"] .el-drawer,
[data-world-style="cuphead"] .el-dialog {
  background:
    repeating-linear-gradient(0deg, rgba(42, 36, 32, 0.025) 0 2px, transparent 2px 4px),
    radial-gradient(ellipse at 30% 0%, #efe2c2 0%, #e8dcc0 60%, #ddcfa8 100%) !important;
  color: #2a2420 !important;
  border: 4px double #2a2420 !important;
  box-shadow: 4px 4px 0 #2a2420 !important;
}

[data-world-style="cuphead"] .el-drawer__header,
[data-world-style="cuphead"] .el-dialog__header {
  color: #2a2420 !important;
  border-bottom: 2px solid #2a2420 !important;
  padding-bottom: 12px;
  font-family: 'Cabin Sketch', 'Noto Sans TC', cursive !important;
  font-weight: 700 !important;
}

[data-world-style="cuphead"] .el-drawer__title,
[data-world-style="cuphead"] .el-dialog__title {
  color: #a0523c !important;
  font-family: 'Cabin Sketch', 'Noto Sans TC', cursive !important;
  font-weight: 700 !important;
  letter-spacing: 1px !important;
}

[data-world-style="cuphead"] .el-drawer__close-btn,
[data-world-style="cuphead"] .el-dialog__headerbtn .el-dialog__close {
  color: #2a2420 !important;
}

/* ── el-switch ── */

[data-world-style="plastic"] .el-switch__core {
  background-color: rgba(26, 17, 64, 0.25) !important;
  border: 2px solid #1a1140 !important;
  border-radius: 14px !important;
  height: 24px !important;
  min-width: 46px !important;
}

[data-world-style="plastic"] .el-switch__core .el-switch__action {
  background-color: #ffffff !important;
  border: 1.5px solid #1a1140 !important;
  width: 18px !important;
  height: 18px !important;
  top: 1px !important;
}

[data-world-style="plastic"] .el-switch.is-checked .el-switch__core {
  background: linear-gradient(180deg, #76ff03 0%, #00c853 100%) !important;
  border-color: #1a1140 !important;
}

[data-world-style="plastic"] .el-switch.is-checked .el-switch__core .el-switch__action {
  background-color: #ffea00 !important;
}

[data-world-style="cuphead"] .el-switch__core {
  background-color: #d8c8a4 !important;
  border: 2px solid #2a2420 !important;
  border-radius: 0 !important;
  height: 22px !important;
  min-width: 44px !important;
  box-shadow: 2px 2px 0 #2a2420 !important;
}

[data-world-style="cuphead"] .el-switch__core .el-switch__action {
  background-color: #f0e4cc !important;
  border: 1.5px solid #2a2420 !important;
  border-radius: 0 !important;
  width: 16px !important;
  height: 16px !important;
  top: 1px !important;
}

[data-world-style="cuphead"] .el-switch.is-checked .el-switch__core {
  background-color: #c4a035 !important;
  border-color: #2a2420 !important;
}

[data-world-style="cuphead"] .el-switch.is-checked .el-switch__core .el-switch__action {
  background-color: #a0523c !important;
}

/* ── el-slider ── */

[data-world-style="plastic"] .el-slider__runway {
  background: rgba(26, 17, 64, 0.18) !important;
  border: 1.5px solid #1a1140 !important;
  border-radius: 8px !important;
  height: 8px !important;
}

[data-world-style="plastic"] .el-slider__bar {
  background: linear-gradient(90deg, #00e5ff 0%, #ff3b8d 100%) !important;
  border-radius: 8px !important;
  height: 8px !important;
}

[data-world-style="plastic"] .el-slider__button {
  width: 20px !important;
  height: 20px !important;
  background: linear-gradient(180deg, #ffea00 0%, #ffb300 100%) !important;
  border: 2.5px solid #1a1140 !important;
  box-shadow: 0 3px 0 #1a1140 !important;
  border-radius: 50% !important;
  transition: transform 0.1s, box-shadow 0.1s !important;
}

[data-world-style="plastic"] .el-slider__button:hover,
[data-world-style="plastic"] .el-slider__button.hover {
  transform: scale(1.1);
  box-shadow: 0 4px 0 #1a1140 !important;
}

[data-world-style="plastic"] .el-slider__button.dragging {
  transform: scale(1.15);
}

[data-world-style="cuphead"] .el-slider__runway {
  background: #d8c8a4 !important;
  border: 2px solid #2a2420 !important;
  border-radius: 0 !important;
  height: 10px !important;
}

[data-world-style="cuphead"] .el-slider__bar {
  background: #c4a035 !important;
  border-radius: 0 !important;
  height: 10px !important;
}

[data-world-style="cuphead"] .el-slider__button {
  width: 20px !important;
  height: 20px !important;
  background: #a0523c !important;
  border: 2.5px solid #2a2420 !important;
  border-radius: 50% !important;
  box-shadow: 2px 2px 0 #2a2420 !important;
  transition: transform 0.1s, box-shadow 0.1s !important;
}

[data-world-style="cuphead"] .el-slider__button:hover,
[data-world-style="cuphead"] .el-slider__button.hover {
  transform: scale(1.1);
  box-shadow: 3px 3px 0 #2a2420 !important;
}

[data-world-style="cuphead"] .el-slider__button.dragging {
  transform: scale(1.15);
}

/* Make element plus form inputs inside drawers readable on the new bg */
[data-world-style="plastic"] .el-drawer .el-input__wrapper,
[data-world-style="plastic"] .el-dialog .el-input__wrapper,
[data-world-style="plastic"] .el-drawer .el-textarea__inner,
[data-world-style="plastic"] .el-dialog .el-textarea__inner {
  background: #ffffff !important;
  box-shadow: 0 0 0 2px #1a1140 inset !important;
  color: #1a1140 !important;
}

[data-world-style="cuphead"] .el-drawer .el-input__wrapper,
[data-world-style="cuphead"] .el-dialog .el-input__wrapper,
[data-world-style="cuphead"] .el-drawer .el-textarea__inner,
[data-world-style="cuphead"] .el-dialog .el-textarea__inner {
  background: #f0e4cc !important;
  box-shadow: 0 0 0 2px #2a2420 inset !important;
  color: #2a2420 !important;
}

[data-world-style="cuphead"] .el-segmented {
  border: 2px solid #2a2420 !important;
  background: rgba(232, 220, 192, 0.6) !important;
  box-shadow: 2px 2px 0 #2a2420 !important;
}

[data-world-style="cuphead"] .el-segmented__item-selected,
[data-world-style="cuphead"] .el-segmented .is-selected,
[data-world-style="cuphead"] .el-radio-button__original-radio:checked + .el-radio-button__inner {
  background: #c4a035 !important;
  color: #2a2420 !important;
  box-shadow: none !important;
}

[data-world-style="cuphead"] .el-radio-button__inner {
  border-color: #2a2420 !important;
  background: rgba(232, 220, 192, 0.55) !important;
  color: #2a2420 !important;
}

[data-world-style="plastic"] .el-segmented {
  border: 2px solid #1a1140 !important;
  background: linear-gradient(180deg, #ffffff 0%, #ffe5f1 100%) !important;
  box-shadow: 0 3px 0 #1a1140 !important;
}

[data-world-style="plastic"] .el-segmented__item,
[data-world-style="plastic"] .el-radio-button__inner {
  color: #1a1140 !important;
  font-weight: 600 !important;
}

[data-world-style="plastic"] .el-segmented__item-selected,
[data-world-style="plastic"] .el-segmented .is-selected,
[data-world-style="plastic"] .el-radio-button__original-radio:checked + .el-radio-button__inner {
  background: linear-gradient(180deg, #ff3b8d 0%, #d500f9 100%) !important;
  color: #ffffff !important;
  box-shadow: none !important;
}

[data-world-style="plastic"] .el-radio-button__inner {
  border-color: #1a1140 !important;
  background: linear-gradient(180deg, #ffffff 0%, #ffe5f1 100%) !important;
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
