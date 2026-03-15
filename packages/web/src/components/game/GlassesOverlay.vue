<template>
  <div v-if="visible" class="glasses-overlay">
    <svg
      viewBox="0 0 1920 1080"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <!--
          Multi-stop radial gradient for plastic depth:
          - Top-left specular highlight (lighter)
          - Center body color
          - Bottom darker shadow
        -->
        <radialGradient id="frameRadial" cx="0.35" cy="0.25" r="0.85" fx="0.3" fy="0.2">
          <stop offset="0%" :stop-color="frameBright" stop-opacity="0.95" />
          <stop offset="35%" :stop-color="frameLighter" stop-opacity="0.93" />
          <stop offset="70%" :stop-color="frameColor" stop-opacity="0.9" />
          <stop offset="100%" :stop-color="frameDarker" stop-opacity="0.92" />
        </radialGradient>

        <!-- Top-edge specular highlight strip -->
        <linearGradient id="specularTop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="white" :stop-opacity="specularOpacity" />
          <stop offset="15%" stop-color="white" :stop-opacity="specularOpacity * 0.36" />
          <stop offset="40%" stop-color="white" stop-opacity="0" />
        </linearGradient>

        <!-- Bottom shadow gradient -->
        <linearGradient id="shadowBottom" x1="0" y1="0" x2="0" y2="1">
          <stop offset="60%" stop-color="black" stop-opacity="0" />
          <stop offset="100%" stop-color="black" :stop-opacity="shadowOpacity" />
        </linearGradient>

        <!-- Inner edge bevel highlight -->
        <linearGradient id="innerBevel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="white" stop-opacity="0.12" />
          <stop offset="50%" stop-color="white" stop-opacity="0.04" />
          <stop offset="100%" stop-color="black" stop-opacity="0.08" />
        </linearGradient>
      </defs>

      <!-- Main frame body with radial gradient -->
      <path
        fill-rule="evenodd"
        fill="url(#frameRadial)"
        :d="framePath"
      />

      <!-- Top specular highlight layer -->
      <path
        fill-rule="evenodd"
        fill="url(#specularTop)"
        :d="framePath"
      />

      <!-- Bottom shadow layer -->
      <path
        fill-rule="evenodd"
        fill="url(#shadowBottom)"
        :d="framePath"
      />

      <!-- Inner lens edge bevel — gives depth to the cutout rim -->
      <path
        fill="none"
        stroke="url(#innerBevel)"
        stroke-width="3"
        :d="lensOutlinePath"
      />

      <!-- Thin bright inner highlight line -->
      <path
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        stroke-width="1"
        :d="lensOutlinePath"
      />
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  visible: boolean;
  frameColor: string;
  frameMaterial?: 'plastic' | 'metallic' | 'matte';
}>();

/** Parse hex to RGB components. */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${Math.min(255, Math.max(0, r)).toString(16).padStart(2, '0')}${Math.min(255, Math.max(0, g)).toString(16).padStart(2, '0')}${Math.min(255, Math.max(0, b)).toString(16).padStart(2, '0')}`;
}

/** Material-dependent gradient parameters. */
const materialParams = computed(() => {
  switch (props.frameMaterial ?? 'plastic') {
    case 'metallic': return { bright: 100, lighter: 70, darker: -50, specular: 0.45, shadow: 0.25 };
    case 'matte':    return { bright: 30,  lighter: 20, darker: -15, specular: 0.08, shadow: 0.08 };
    default:         return { bright: 70,  lighter: 40, darker: -30, specular: 0.22, shadow: 0.15 };
  }
});

const frameBright = computed(() => {
  const [r, g, b] = hexToRgb(props.frameColor);
  const o = materialParams.value.bright;
  return rgbToHex(r + o, g + o, b + o);
});

const frameLighter = computed(() => {
  const [r, g, b] = hexToRgb(props.frameColor);
  const o = materialParams.value.lighter;
  return rgbToHex(r + o, g + o, b + o);
});

const frameDarker = computed(() => {
  const [r, g, b] = hexToRgb(props.frameColor);
  const o = materialParams.value.darker;
  return rgbToHex(r + o, g + o, b + o);
});

const specularOpacity = computed(() => materialParams.value.specular);
const shadowOpacity = computed(() => materialParams.value.shadow);

/**
 * SVG path for the one-piece visor frame.
 *
 * Outer rectangle = full 1920x1080 viewport.
 * Inner cutout = single large lens opening with:
 *   - Curved top (slight upward arc)
 *   - Wide sides that sweep down
 *   - V-shaped nose bridge notch at bottom center
 *
 * Coordinates designed for viewBox="0 0 1920 1080"
 */
const framePath = computed(() => {
  // Outer rectangle (clockwise)
  const outer = 'M0,0 L1920,0 L1920,1080 L0,1080 Z';

  // Inner lens cutout (counter-clockwise for evenodd)
  const lx = 60;     // left edge X
  const rx = 1860;   // right edge X
  const ty = 80;     // top Y
  const by = 960;    // bottom Y (before nose bridge)
  const cx = 960;    // center X
  const nw = 80;     // nose bridge half-width
  const nd = 70;     // nose bridge depth (how far down the V goes)

  // Top arc control point (slight upward bulge)
  const tcy = ty - 30;

  // Side curves
  const sly = 400;
  const sry = 400;
  const slx = lx - 15;
  const srx = rx + 15;

  // Bottom curves approaching nose bridge
  const bly = by + 20;
  const bry = by + 20;

  const inner = [
    `M${lx},${sly}`,
    `Q${slx},${ty + 60} ${lx + 80},${ty}`,
    `Q${cx},${tcy} ${rx - 80},${ty}`,
    `Q${srx},${ty + 60} ${rx},${sry}`,
    `Q${srx},${by - 60} ${rx - 80},${by}`,
    `Q${cx + 200},${bry} ${cx + nw},${by}`,
    `L${cx},${by + nd}`,
    `L${cx - nw},${by}`,
    `Q${cx - 200},${bly} ${lx + 80},${by}`,
    `Q${slx},${by - 60} ${lx},${sly}`,
    'Z',
  ].join(' ');

  return `${outer} ${inner}`;
});

/** Just the inner lens outline path (for the highlight stroke). */
const lensOutlinePath = computed(() => {
  const lx = 60;
  const rx = 1860;
  const ty = 80;
  const by = 960;
  const cx = 960;
  const nw = 80;
  const nd = 70;
  const tcy = ty - 30;
  const sly = 400;
  const sry = 400;
  const slx = lx - 15;
  const srx = rx + 15;
  const bly = by + 20;
  const bry = by + 20;

  return [
    `M${lx},${sly}`,
    `Q${slx},${ty + 60} ${lx + 80},${ty}`,
    `Q${cx},${tcy} ${rx - 80},${ty}`,
    `Q${srx},${ty + 60} ${rx},${sry}`,
    `Q${srx},${by - 60} ${rx - 80},${by}`,
    `Q${cx + 200},${bry} ${cx + nw},${by}`,
    `L${cx},${by + nd}`,
    `L${cx - nw},${by}`,
    `Q${cx - 200},${bly} ${lx + 80},${by}`,
    `Q${slx},${by - 60} ${lx},${sly}`,
    'Z',
  ].join(' ');
});
</script>

<style scoped>
.glasses-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
}

.glasses-overlay svg {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
