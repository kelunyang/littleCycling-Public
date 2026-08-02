<!--
  Debug hover inspector — point the mouse at anything in the 3D world and it
  names itself, right there on screen.

  Built because "which object IS that black line?" survived five rounds of
  guess-then-bisect. The click-identify already logged the answer to the
  console, but reading devtools between rides is slow; sweeping the cursor
  along a mystery line and watching the name change is instant.

  Shows the whole stack the ray passed through, not just the front-most: the
  thing being hunted is often BEHIND the surface you think you are pointing at.
  Font Awesome icons only, per project convention.
-->
<template>
  <div
    v-if="on && hits.length > 0"
    class="scene-inspector"
    :style="{ left: `${pos.x + 18}px`, top: `${pos.y + 18}px` }"
  >
    <div class="scene-inspector__head">
      <font-awesome-icon icon="crosshairs" />
      <span>{{ hits.length }} hit{{ hits.length === 1 ? '' : 's' }}</span>
    </div>
    <div
      v-for="(h, i) in hits"
      :key="i"
      class="scene-inspector__row"
      :class="{ 'scene-inspector__row--first': i === 0 }"
    >
      <div class="scene-inspector__name">
        <span
          v-if="h.colour"
          class="scene-inspector__swatch"
          :style="{ background: h.colour }"
        />
        {{ h.name }}
      </div>
      <div class="scene-inspector__meta">
        <span>{{ h.dist }}m</span>
        <span>y={{ h.point[1] }}</span>
        <!-- The number that has mattered every single time. -->
        <span v-if="h.aboveGround !== null" :class="{ 'is-floating': h.aboveGround > 2 }">
          ↑{{ h.aboveGround }}m
        </span>
        <span v-if="h.backface" class="is-backface">BACK</span>
        <span class="scene-inspector__mat">{{ h.mat }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface ProbeHit {
  name: string;
  mat?: string;
  colour?: string;
  dist: number;
  point: [number, number, number];
  aboveGround: number | null;
  backface?: boolean;
}

defineProps<{
  on: boolean;
  hits: ProbeHit[];
  pos: { x: number; y: number };
}>();
</script>

<style scoped lang="scss">
.scene-inspector {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  max-width: 30rem;
  padding: 0.4rem 0.55rem;
  border-radius: 0.3rem;
  background: rgba(8, 10, 16, 0.92);
  border: 1px solid rgba(var(--accent-rgb, 0, 229, 255), 0.5);
  color: #e8eef6;
  font: 400 0.72rem/1.45 ui-monospace, "SFMono-Regular", Menlo, monospace;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.55);
}

.scene-inspector__head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding-bottom: 0.25rem;
  margin-bottom: 0.25rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
  opacity: 0.75;
}

.scene-inspector__row {
  padding: 0.12rem 0;
  opacity: 0.62;

  &--first {
    opacity: 1;
  }
}

.scene-inspector__name {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-weight: 600;
}

.scene-inspector__swatch {
  width: 0.62rem;
  height: 0.62rem;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.4);
}

.scene-inspector__meta {
  display: flex;
  gap: 0.55rem;
  padding-left: 0.1rem;
  opacity: 0.8;
}

.scene-inspector__mat {
  opacity: 0.55;
}

.is-floating {
  color: #ff5c8a;
  font-weight: 700;
}

.is-backface {
  color: #ffd400;
  font-weight: 700;
}
</style>
