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
    const style = settingsStore.config.map.worldStyle ?? 'plastic';
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

  /* ── Chart tokens(課表視覺化 segment identity)──
     dataviz skill 已跑 validate_palette.js:CVD ΔE 25.7、對比 3:1+ 全過。
     這組深色值鏡像 shared SEGMENT_TYPE_COLORS(training-plan.ts,warmup/cooldown
     共用冷藍、interval_work→work、interval_rest→rest);改任一邊要同步。
     SVG fill 一律引用這些 CSS var,不在元件裡寫死 hex。 */
  --chart-seg-warmup: #4a90d9;
  --chart-seg-steady: #66bb6a;
  --chart-seg-work: #ff6d00;
  --chart-seg-rest: #00e676;
  --chart-seg-cooldown: #4a90d9;
  --chart-actual: var(--hud-text-bright);

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
  --hud-text: var(--pl-ink-mid);
  --hud-text-bright: var(--pl-ink-deep);
  --hud-text-dim: rgba(var(--pl-ink-mid-rgb), 0.55);
  --hud-cyan: var(--pl-pink);
  --hud-yellow: var(--pl-yellow);
  --hud-magenta: var(--pl-pink);
  --hud-border: rgba(var(--pl-pink-rgb), 0.4);
  --hud-border-bright: rgba(var(--pl-pink-rgb), 0.85);

  --accent-rgb: 255, 59, 141;
  --accent-soft: rgba(var(--pl-pink-rgb), 0.08);
  --accent-tint: rgba(var(--pl-pink-rgb), 0.14);
  --accent-hover: rgba(var(--pl-pink-rgb), 0.25);
  --accent-strong: rgba(var(--pl-pink-rgb), 0.6);
  --accent-glow-soft: 0 4px 0 rgba(var(--pl-shadow-rgb), 0.18);
  --accent-glow-strong: 0 6px 0 rgba(var(--pl-shadow-rgb), 0.22), 0 14px 24px rgba(var(--pl-pink-rgb), 0.35);

  --card-radius: 28px;
  --card-radius-sm: 14px;
  --card-shadow: drop-shadow(0 6px 0 rgba(var(--pl-shadow-rgb), 0.35)) drop-shadow(0 16px 32px rgba(0, 229, 255, 0.25));
  --font-display: 'Fredoka', 'Baloo 2', 'Noto Sans TC', system-ui, sans-serif;
  --font-body: 'Quicksand', 'Nunito', 'Noto Sans TC', system-ui, sans-serif;

  /* Solid surface colour — used by Element Plus drawer/dialog (background-color
     can't render gradients, so the gradient version goes on the welcome card
     directly). */
  --surface: var(--pl-paper);
  --surface-light: #ffffff;
  --surface-gradient: linear-gradient(180deg, var(--pl-paper-hi) 0%, var(--pl-paper) 100%);
  --border: rgba(var(--pl-pink-rgb), 0.3);

  /* Element Plus var overrides — apply same colour to drawer/dialog/popover. */
  --el-bg-color: var(--pl-paper);
  --el-bg-color-overlay: var(--pl-paper-hi);
  --el-bg-color-page: var(--pl-paper-lo);
  --el-text-color-primary: var(--pl-ink-deep);
  --el-text-color-regular: var(--pl-ink-mid);
  --el-border-color: rgba(var(--pl-pink-rgb), 0.4);
  --el-fill-color-blank: var(--pl-paper-hi);
  --el-fill-color-light: var(--pl-paper);

  /* Primary buttons/switches: without these Element falls back to its own blue,
     which is the one thing on a pink paper card that reads as "not ours".
     The light-N ramp is what Element mixes hover/plain/disabled states from —
     overriding only --el-color-primary leaves those states blue. */
  --el-color-primary: var(--pl-pink);
  --el-color-primary-light-3: rgba(var(--pl-pink-rgb), 0.7);
  --el-color-primary-light-5: rgba(var(--pl-pink-rgb), 0.5);
  --el-color-primary-light-7: rgba(var(--pl-pink-rgb), 0.3);
  --el-color-primary-light-8: rgba(var(--pl-pink-rgb), 0.2);
  --el-color-primary-light-9: rgba(var(--pl-pink-rgb), 0.1);
  --el-color-primary-dark-2: color-mix(in srgb, var(--pl-pink) 80%, black);

  /* Flatten cyberpunk angled chamfers; themes use border-radius instead. */
  --clip-panel: none;
  --clip-panel-sm: none;
  --clip-panel-lg: none;

  --hud-glow-cyan: 0 4px 0 rgba(var(--pl-shadow-rgb), 0.25);
  --hud-glow-cyan-strong: 0 4px 0 rgba(var(--pl-shadow-rgb), 0.25), 0 8px 16px rgba(var(--pl-pink-rgb), 0.35);

  /* ── Chart tokens(淺紙底把霓虹洗掉的同色相深化 step)──
     dataviz 已驗證:兩種紙底全項 PASS。這不是 SEGMENT_TYPE_COLORS 的鏡像,
     是為淺色主題另跑過的深化值,勿隨意調亮。 */
  --chart-seg-warmup: #2f6cb3;
  --chart-seg-steady: #2e7d32;
  --chart-seg-work: #c65400;
  --chart-seg-rest: #00875a;
  --chart-seg-cooldown: #2f6cb3;
  --chart-actual: var(--hud-text-bright);
}

/* ─── Cuphead theme tokens ─── */
[data-world-style="cuphead"] {
  --hud-bg: rgba(var(--ck-paper-rgb), 0.95);
  --hud-bg-light: rgba(240, 228, 200, 0.92);
  --hud-text: var(--ck-ink-soft);
  --hud-text-bright: var(--ck-ink);
  --hud-text-dim: rgba(var(--ck-ink-soft-rgb), 0.6);
  --hud-cyan: var(--ck-olive);
  --hud-yellow: var(--ck-gold);
  --hud-magenta: var(--ck-rust);
  --hud-border: rgba(var(--ck-ink-rgb), 0.55);
  --hud-border-bright: var(--ck-ink);

  --accent-rgb: 107, 127, 59;
  --accent-soft: rgba(var(--ck-gold-rgb), 0.10);
  --accent-tint: rgba(var(--ck-gold-rgb), 0.18);
  --accent-hover: rgba(var(--ck-rust-rgb), 0.18);
  --accent-strong: rgba(var(--ck-ink-rgb), 0.55);
  --accent-glow-soft: 2px 2px 0 var(--ck-ink);
  --accent-glow-strong: 3px 3px 0 var(--ck-ink);

  --card-radius: 0;
  --card-radius-sm: 0;
  --card-shadow: drop-shadow(4px 4px 0 var(--ck-ink));
  /* 'Noto Sans TC' 擋在 cursive 前：Windows 的 cursive 是標楷體 */
  --font-display: 'Cabin Sketch', 'Patrick Hand', 'Noto Sans TC', cursive;
  --font-body: 'Patrick Hand', 'Comic Sans MS', 'Noto Sans TC', cursive;

  --surface: var(--ck-paper);
  --surface-light: var(--ck-paper-hi);
  --surface-gradient:
    repeating-linear-gradient(0deg, rgba(var(--ck-ink-rgb), 0.02) 0 2px, transparent 2px 4px),
    radial-gradient(ellipse at 30% 20%, var(--ck-paper-warm) 0%, var(--ck-paper) 60%, var(--ck-paper-lo) 100%);
  --border: rgba(var(--ck-ink-rgb), 0.45);

  --el-bg-color: var(--ck-paper);
  --el-bg-color-overlay: var(--ck-paper-hi);
  --el-bg-color-page: var(--ck-paper-lo);
  --el-text-color-primary: var(--ck-ink);
  --el-text-color-regular: var(--ck-ink-soft);
  --el-border-color: rgba(var(--ck-ink-rgb), 0.55);
  --el-fill-color-blank: var(--ck-paper-hi);
  --el-fill-color-light: var(--ck-paper);

  --el-color-primary: var(--ck-rust);
  --el-color-primary-light-3: rgba(var(--ck-rust-rgb), 0.7);
  --el-color-primary-light-5: rgba(var(--ck-rust-rgb), 0.5);
  --el-color-primary-light-7: rgba(var(--ck-rust-rgb), 0.3);
  --el-color-primary-light-8: rgba(var(--ck-rust-rgb), 0.2);
  --el-color-primary-light-9: rgba(var(--ck-rust-rgb), 0.1);
  --el-color-primary-dark-2: color-mix(in srgb, var(--ck-rust) 80%, black);

  --clip-panel: none;
  --clip-panel-sm: none;
  --clip-panel-lg: none;

  --hud-glow-cyan: 2px 2px 0 var(--ck-ink);
  --hud-glow-cyan-strong: 3px 3px 0 var(--ck-ink);

  /* ── Chart tokens(淺紙底把霓虹洗掉的同色相深化 step)──
     dataviz 已驗證:兩種紙底全項 PASS。這不是 SEGMENT_TYPE_COLORS 的鏡像,
     是為淺色主題另跑過的深化值,勿隨意調亮。 */
  --chart-seg-warmup: #2f6cb3;
  --chart-seg-steady: #2e7d32;
  --chart-seg-work: #c65400;
  --chart-seg-rest: #00875a;
  --chart-seg-cooldown: #2f6cb3;
  --chart-actual: var(--hud-text-bright);
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
  border: 2px solid var(--ck-ink) !important;
  background: rgba(var(--ck-paper-rgb), 0.6) !important;
  box-shadow: 2px 2px 0 var(--ck-ink) !important;
}

[data-world-style="cuphead"] .el-input-number .el-input__inner {
  color: var(--ck-ink) !important;
  font-family: 'Cabin Sketch', 'Noto Sans TC', cursive !important;
}

[data-world-style="cuphead"] .el-input-number__decrease,
[data-world-style="cuphead"] .el-input-number__increase {
  background: var(--ck-gold) !important;
  color: var(--ck-ink) !important;
  border-color: var(--ck-ink) !important;
}

[data-world-style="cuphead"] .el-input-number__decrease:hover,
[data-world-style="cuphead"] .el-input-number__increase:hover {
  background: var(--ck-rust) !important;
  color: var(--ck-paper-hi) !important;
}

[data-world-style="plastic"] .el-input-number {
  border: 2px solid var(--pl-ink) !important;
  background: linear-gradient(180deg, #ffffff 0%, var(--pl-paper) 100%) !important;
  box-shadow: 0 3px 0 var(--pl-ink) !important;
  border-radius: 14px !important;
}

[data-world-style="plastic"] .el-input-number .el-input__inner {
  color: var(--pl-ink) !important;
  font-family: 'Fredoka', 'Noto Sans TC', sans-serif !important;
}

[data-world-style="plastic"] .el-input-number__decrease,
[data-world-style="plastic"] .el-input-number__increase {
  background: linear-gradient(180deg, #00e5ff 0%, var(--pl-cyan-deep) 100%) !important;
  color: #ffffff !important;
  border-color: var(--pl-ink) !important;
}

[data-world-style="plastic"] .el-input-number__decrease:hover,
[data-world-style="plastic"] .el-input-number__increase:hover {
  background: linear-gradient(180deg, var(--pl-pink) 0%, var(--pl-purple) 100%) !important;
  color: #ffffff !important;
}

/* ─── Element Plus drawer + dialog backgrounds (teleported to body) ─── */

[data-world-style="plastic"] .el-drawer,
[data-world-style="plastic"] .el-dialog {
  background:
    radial-gradient(ellipse at 30% 0%, var(--pl-paper-hi) 0%, var(--pl-paper) 70%, var(--pl-paper-lo) 100%) !important;
  color: var(--pl-ink-deep) !important;
  border: 3px solid var(--pl-ink) !important;
  box-shadow: 0 8px 0 var(--pl-ink), 0 16px 32px rgba(var(--pl-pink-rgb), 0.45) !important;
}

[data-world-style="plastic"] .el-drawer__header,
[data-world-style="plastic"] .el-dialog__header {
  color: var(--pl-pink) !important;
  border-bottom: 2px dashed rgba(var(--pl-ink-rgb), 0.3) !important;
  padding-bottom: 12px;
  font-family: 'Fredoka', 'Noto Sans TC', sans-serif !important;
  font-weight: 700 !important;
}

[data-world-style="plastic"] .el-drawer__title,
[data-world-style="plastic"] .el-dialog__title {
  color: var(--pl-ink) !important;
  font-family: 'Fredoka', 'Noto Sans TC', sans-serif !important;
  font-weight: 700 !important;
}

[data-world-style="plastic"] .el-drawer__close-btn,
[data-world-style="plastic"] .el-dialog__headerbtn .el-dialog__close {
  color: var(--pl-ink) !important;
}

[data-world-style="cuphead"] .el-drawer,
[data-world-style="cuphead"] .el-dialog {
  background:
    repeating-linear-gradient(0deg, rgba(var(--ck-ink-rgb), 0.025) 0 2px, transparent 2px 4px),
    radial-gradient(ellipse at 30% 0%, var(--ck-paper-warm) 0%, var(--ck-paper) 60%, var(--ck-paper-lo) 100%) !important;
  color: var(--ck-ink) !important;
  border: 4px double var(--ck-ink) !important;
  box-shadow: 4px 4px 0 var(--ck-ink) !important;
}

[data-world-style="cuphead"] .el-drawer__header,
[data-world-style="cuphead"] .el-dialog__header {
  color: var(--ck-ink) !important;
  border-bottom: 2px solid var(--ck-ink) !important;
  padding-bottom: 12px;
  font-family: 'Cabin Sketch', 'Noto Sans TC', cursive !important;
  font-weight: 700 !important;
}

[data-world-style="cuphead"] .el-drawer__title,
[data-world-style="cuphead"] .el-dialog__title {
  color: var(--ck-rust) !important;
  font-family: 'Cabin Sketch', 'Noto Sans TC', cursive !important;
  font-weight: 700 !important;
  letter-spacing: 1px !important;
}

[data-world-style="cuphead"] .el-drawer__close-btn,
[data-world-style="cuphead"] .el-dialog__headerbtn .el-dialog__close {
  color: var(--ck-ink) !important;
}

/* ── el-switch ── */

[data-world-style="plastic"] .el-switch__core {
  background-color: rgba(var(--pl-ink-rgb), 0.25) !important;
  border: 2px solid var(--pl-ink) !important;
  border-radius: 14px !important;
  height: 24px !important;
  min-width: 46px !important;
}

[data-world-style="plastic"] .el-switch__core .el-switch__action {
  background-color: #ffffff !important;
  border: 1.5px solid var(--pl-ink) !important;
  width: 18px !important;
  height: 18px !important;
  top: 1px !important;
}

[data-world-style="plastic"] .el-switch.is-checked .el-switch__core {
  background: linear-gradient(180deg, var(--pl-green) 0%, var(--pl-green-deep) 100%) !important;
  border-color: var(--pl-ink) !important;
}

[data-world-style="plastic"] .el-switch.is-checked .el-switch__core .el-switch__action {
  background-color: var(--pl-yellow) !important;
}

[data-world-style="cuphead"] .el-switch__core {
  background-color: var(--ck-tan) !important;
  border: 2px solid var(--ck-ink) !important;
  border-radius: 0 !important;
  height: 22px !important;
  min-width: 44px !important;
  box-shadow: 2px 2px 0 var(--ck-ink) !important;
}

[data-world-style="cuphead"] .el-switch__core .el-switch__action {
  background-color: var(--ck-paper-hi) !important;
  border: 1.5px solid var(--ck-ink) !important;
  border-radius: 0 !important;
  width: 16px !important;
  height: 16px !important;
  top: 1px !important;
}

[data-world-style="cuphead"] .el-switch.is-checked .el-switch__core {
  background-color: var(--ck-gold) !important;
  border-color: var(--ck-ink) !important;
}

[data-world-style="cuphead"] .el-switch.is-checked .el-switch__core .el-switch__action {
  background-color: var(--ck-rust) !important;
}

/* ── el-slider ── */

[data-world-style="plastic"] .el-slider__runway {
  background: rgba(var(--pl-ink-rgb), 0.18) !important;
  border: 1.5px solid var(--pl-ink) !important;
  border-radius: 8px !important;
  height: 8px !important;
}

[data-world-style="plastic"] .el-slider__bar {
  background: linear-gradient(90deg, #00e5ff 0%, var(--pl-pink) 100%) !important;
  border-radius: 8px !important;
  height: 8px !important;
}

[data-world-style="plastic"] .el-slider__button {
  width: 20px !important;
  height: 20px !important;
  background: linear-gradient(180deg, var(--pl-yellow) 0%, var(--pl-amber) 100%) !important;
  border: 2.5px solid var(--pl-ink) !important;
  box-shadow: 0 3px 0 var(--pl-ink) !important;
  border-radius: 50% !important;
  transition: transform 0.1s, box-shadow 0.1s !important;
}

[data-world-style="plastic"] .el-slider__button:hover,
[data-world-style="plastic"] .el-slider__button.hover {
  transform: scale(1.1);
  box-shadow: 0 4px 0 var(--pl-ink) !important;
}

[data-world-style="plastic"] .el-slider__button.dragging {
  transform: scale(1.15);
}

[data-world-style="cuphead"] .el-slider__runway {
  background: var(--ck-tan) !important;
  border: 2px solid var(--ck-ink) !important;
  border-radius: 0 !important;
  height: 10px !important;
}

[data-world-style="cuphead"] .el-slider__bar {
  background: var(--ck-gold) !important;
  border-radius: 0 !important;
  height: 10px !important;
}

[data-world-style="cuphead"] .el-slider__button {
  width: 20px !important;
  height: 20px !important;
  background: var(--ck-rust) !important;
  border: 2.5px solid var(--ck-ink) !important;
  border-radius: 50% !important;
  box-shadow: 2px 2px 0 var(--ck-ink) !important;
  transition: transform 0.1s, box-shadow 0.1s !important;
}

[data-world-style="cuphead"] .el-slider__button:hover,
[data-world-style="cuphead"] .el-slider__button.hover {
  transform: scale(1.1);
  box-shadow: 3px 3px 0 var(--ck-ink) !important;
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
  box-shadow: 0 0 0 2px var(--pl-ink) inset !important;
  color: var(--pl-ink) !important;
}

[data-world-style="cuphead"] .el-drawer .el-input__wrapper,
[data-world-style="cuphead"] .el-dialog .el-input__wrapper,
[data-world-style="cuphead"] .el-drawer .el-textarea__inner,
[data-world-style="cuphead"] .el-dialog .el-textarea__inner {
  background: var(--ck-paper-hi) !important;
  box-shadow: 0 0 0 2px var(--ck-ink) inset !important;
  color: var(--ck-ink) !important;
}

[data-world-style="cuphead"] .el-segmented {
  border: 2px solid var(--ck-ink) !important;
  background: rgba(var(--ck-paper-rgb), 0.6) !important;
  box-shadow: 2px 2px 0 var(--ck-ink) !important;
}

[data-world-style="cuphead"] .el-segmented__item-selected,
[data-world-style="cuphead"] .el-segmented .is-selected,
[data-world-style="cuphead"] .el-radio-button__original-radio:checked + .el-radio-button__inner {
  background: var(--ck-gold) !important;
  color: var(--ck-ink) !important;
  box-shadow: none !important;
}

[data-world-style="cuphead"] .el-radio-button__inner {
  border-color: var(--ck-ink) !important;
  background: rgba(var(--ck-paper-rgb), 0.55) !important;
  color: var(--ck-ink) !important;
}

[data-world-style="plastic"] .el-segmented {
  border: 2px solid var(--pl-ink) !important;
  background: linear-gradient(180deg, #ffffff 0%, var(--pl-paper) 100%) !important;
  box-shadow: 0 3px 0 var(--pl-ink) !important;
}

[data-world-style="plastic"] .el-segmented__item,
[data-world-style="plastic"] .el-radio-button__inner {
  color: var(--pl-ink) !important;
  font-weight: 600 !important;
}

[data-world-style="plastic"] .el-segmented__item-selected,
[data-world-style="plastic"] .el-segmented .is-selected,
[data-world-style="plastic"] .el-radio-button__original-radio:checked + .el-radio-button__inner {
  background: linear-gradient(180deg, var(--pl-pink) 0%, var(--pl-purple) 100%) !important;
  color: #ffffff !important;
  box-shadow: none !important;
}

[data-world-style="plastic"] .el-radio-button__inner {
  border-color: var(--pl-ink) !important;
  background: linear-gradient(180deg, #ffffff 0%, var(--pl-paper) 100%) !important;
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
