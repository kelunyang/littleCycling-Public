<template>
  <el-drawer
    :model-value="open"
    direction="btt"
    size="100%"
    :with-header="false"
    :append-to-body="true"
    @close="calendar.close()"
  >
    <div class="training-cal__header">
      <h3>
        <font-awesome-icon icon="calendar-days" />
        Training Calendar
      </h3>
      <div class="training-cal__nav">
        <el-button size="small" @click="calendar.navigateMonth(-1)">
          <font-awesome-icon icon="chevron-left" />
        </el-button>
        <el-button size="small" @click="calendar.navigateMonth(1)">
          <font-awesome-icon icon="chevron-right" />
        </el-button>
      </div>
      <el-button circle @click="calendar.close()">
        <font-awesome-icon icon="xmark" />
      </el-button>
    </div>

    <div class="training-cal__body">
      <!-- Two-month view OR month + day list -->
      <div class="training-cal__grid" :class="{ 'training-cal__grid--split': !!calendar.selectedDate.value }">
        <!-- Left month (previous) -->
        <CalendarMonth
          :year="leftYear"
          :month="leftMonth"
          :day-counts="calendar.dayCounts.value"
          :selected-date="calendar.selectedDate.value"
          @select-date="calendar.selectDate"
        />

        <!-- Right: either current month or day ride list -->
        <CalendarMonth
          v-if="!calendar.selectedDate.value"
          :year="rightYear"
          :month="rightMonth"
          :day-counts="calendar.dayCounts.value"
          :selected-date="calendar.selectedDate.value"
          @select-date="calendar.selectDate"
        />

        <DayRideList
          v-else
          :date="calendar.selectedDate.value"
          :rides="calendar.selectedDateRides.value"
          @back="calendar.clearDate()"
          @select-ride="calendar.openDetail"
        />
      </div>

      <div v-if="calendar.loading.value" class="training-cal__loading">
        <font-awesome-icon icon="spinner" spin />
      </div>
    </div>
  </el-drawer>

  <!-- Nested detail drawer -->
  <RideDetailDrawer
    :open="calendar.detailOpen.value"
    :ride="calendar.detailRide.value"
    :samples="calendar.detailSamples.value"
    :loading="calendar.detailLoading.value"
    @close="calendar.closeDetail()"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import CalendarMonth from './CalendarMonth.vue';
import DayRideList from './DayRideList.vue';
import RideDetailDrawer from './RideDetailDrawer.vue';
import { useCalendar } from '@/composables/useCalendar';

defineProps<{
  open: boolean;
}>();

const calendar = useCalendar();

const leftYear = computed(() => calendar.viewMonth.value.subtract(1, 'month').year());
const leftMonth = computed(() => calendar.viewMonth.value.subtract(1, 'month').month());
const rightYear = computed(() => calendar.viewMonth.value.year());
const rightMonth = computed(() => calendar.viewMonth.value.month());
</script>

<style scoped>
:deep(.el-drawer__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
}

.training-cal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hud-border-bright);
  position: relative;
  flex-shrink: 0;
}

.training-cal__header::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
  opacity: 0.5;
}

.training-cal__header h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(0,229,255,0.3);
}

.training-cal__nav {
  display: flex;
  gap: 4px;
}

.training-cal__nav :deep(.el-button),
.training-cal__header > :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-cyan);
  border-radius: 0;
}

.training-cal__body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  position: relative;
}

.training-cal__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
}

.training-cal__loading {
  position: absolute;
  top: 10px;
  right: 20px;
  color: var(--hud-cyan);
  font-size: 14px;
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
</style>
