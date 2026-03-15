/**
 * Composable managing Training Calendar state.
 * Not a Pinia store — scoped to the calendar drawer only.
 */

import { ref } from 'vue';
import dayjs from 'dayjs';
import type { Ride, RideSample, RideDayCount } from '@littlecycling/shared';
import { notifyWarn } from '@/utils/notify';

const isOpen = ref(false);
const loading = ref(false);
const dayCounts = ref(new Map<string, number>());
const selectedDate = ref<string | null>(null);
const selectedDateRides = ref<Ride[]>([]);

const detailOpen = ref(false);
const detailRide = ref<Ride | null>(null);
const detailSamples = ref<RideSample[]>([]);
const detailLoading = ref(false);

// Which two months are currently displayed (left = previous, right = current)
const viewMonth = ref(dayjs());

async function fetchCalendar() {
  const left = viewMonth.value.subtract(1, 'month').startOf('month');
  const right = viewMonth.value.endOf('month').add(1, 'millisecond');

  const from = left.valueOf();
  const to = right.valueOf();

  try {
    const res = await fetch(`/api/rides/calendar?from=${from}&to=${to}`);
    if (res.ok) {
      const data = await res.json() as { days: RideDayCount[] };
      const m = new Map<string, number>();
      for (const d of data.days) {
        m.set(d.date, d.count);
      }
      dayCounts.value = m;
    }
  } catch {
    notifyWarn('Failed to load calendar data');
  }
}

async function open() {
  isOpen.value = true;
  viewMonth.value = dayjs();
  selectedDate.value = null;
  selectedDateRides.value = [];
  loading.value = true;
  await fetchCalendar();
  loading.value = false;
}

function close() {
  isOpen.value = false;
  selectedDate.value = null;
  selectedDateRides.value = [];
  detailOpen.value = false;
  detailRide.value = null;
  detailSamples.value = [];
}

async function selectDate(dateStr: string) {
  selectedDate.value = dateStr;
  loading.value = true;
  try {
    const res = await fetch(`/api/rides?date=${dateStr}`);
    if (res.ok) {
      const data = await res.json() as { rides: Ride[] };
      selectedDateRides.value = data.rides;
    }
  } catch {
    selectedDateRides.value = [];
    notifyWarn('Failed to load rides for this date');
  }
  loading.value = false;
}

function clearDate() {
  selectedDate.value = null;
  selectedDateRides.value = [];
}

async function openDetail(ride: Ride) {
  detailRide.value = ride;
  detailOpen.value = true;
  detailLoading.value = true;
  try {
    const res = await fetch(`/api/rides/${ride.id}/samples`);
    if (res.ok) {
      const data = await res.json() as { samples: RideSample[] };
      detailSamples.value = data.samples;
    }
  } catch {
    detailSamples.value = [];
    notifyWarn('Failed to load ride samples');
  }
  detailLoading.value = false;
}

function closeDetail() {
  detailOpen.value = false;
  detailRide.value = null;
  detailSamples.value = [];
}

async function navigateMonth(delta: number) {
  viewMonth.value = viewMonth.value.add(delta, 'month');
  selectedDate.value = null;
  selectedDateRides.value = [];
  loading.value = true;
  await fetchCalendar();
  loading.value = false;
}

export function useCalendar() {
  return {
    isOpen,
    loading,
    dayCounts,
    viewMonth,
    selectedDate,
    selectedDateRides,
    detailOpen,
    detailRide,
    detailSamples,
    detailLoading,
    open,
    close,
    selectDate,
    clearDate,
    openDetail,
    closeDetail,
    navigateMonth,
  };
}
