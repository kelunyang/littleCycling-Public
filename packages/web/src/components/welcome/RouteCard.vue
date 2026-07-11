<template>
  <div
    class="route-card"
    :class="{ 'route-card--selected': selected }"
    @click="emit('select')"
  >
    <div class="route-card__info">
      <div class="route-card__name">{{ route.name }}</div>
      <div class="route-card__meta">
        <span class="route-card__stat">
          <font-awesome-icon icon="route" />
          {{ (route.distanceM / 1000).toFixed(1) }} km
        </span>
        <span class="route-card__stat">
          <font-awesome-icon icon="mountain" />
          {{ Math.round(route.elevGainM) }} m
        </span>
        <span class="route-card__stat">
          <font-awesome-icon icon="clock" />
          {{ formatDate(route.createdAt) }}
        </span>
      </div>
    </div>
    <el-button type="danger" circle size="small" @click.stop="emit('remove')" title="Delete route">
      <font-awesome-icon icon="trash" />
    </el-button>
  </div>
</template>

<script setup lang="ts">
import type { SavedRoute } from '@littlecycling/shared';
import dayjs from 'dayjs';

defineProps<{
  route: SavedRoute;
  selected: boolean;
}>();

const emit = defineEmits<{
  select: [];
  remove: [];
}>();

function formatDate(tsEpoch: number): string {
  return dayjs(tsEpoch).format('YYYY-MM-DD');
}
</script>

<style scoped>
.route-card {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s, transform 0.15s, box-shadow 0.15s;
  background: var(--accent-soft);
}

.route-card:hover {
  background: var(--accent-tint);
  border-color: var(--hud-border-bright);
}

.route-card--selected {
  border-color: var(--hud-cyan);
  background: var(--accent-hover);
}

.route-card__info {
  flex: 1;
  min-width: 0;
}

.route-card__name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.5px;
  color: var(--hud-text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.route-card__meta {
  display: flex;
  gap: 12px;
  margin-top: 4px;
}

.route-card__stat {
  font-size: 11px;
  color: var(--hud-text);
  display: flex;
  align-items: center;
  gap: 4px;
  letter-spacing: 0.5px;
}

.route-card__stat :deep(.svg-inline--fa) {
  color: var(--hud-cyan);
  opacity: 0.7;
}
</style>
