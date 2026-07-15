import { ref, onUnmounted } from 'vue';
import { useSensorStore } from '@/stores/sensorStore';
import { useGameStore } from '@/stores/gameStore';
import { useGameStateStore } from '@/stores/gameStateStore';
import {
  parseHrData,
  parseScData,
  parsePwrData,
  type WsMessage,
} from '@littlecycling/shared';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';

export function useWebSocket() {
  const status = ref<WsStatus>('disconnected');
  const lastError = ref<string | null>(null);

  const sensorStore = useSensorStore();
  const gameStore = useGameStore();
  const gameStateStore = useGameStateStore();
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let disposed = false;

  function handleMessage(event: MessageEvent) {
    try {
      const msg = JSON.parse(event.data) as WsMessage;

      if (msg.type === 'sensor') {
        // Anchor the server clock on every frame — even while paused — so the
        // game timer keeps tracking real wall-clock (方案甲: pauses are not
        // deducted, matching the recorded ride duration).
        sensorStore.updateClock(msg.elapsed);
        // 只有「騎乘中途暫停」(pause overlay)才凍結即時感測讀數;start prompt 不凍結——
        // 「踩踏即開始」的 watch 需要即時 power/cadence,而此時 currentRideId 仍為 null
        // (延後錄製,尚未 POST /api/live/start)。凍結會讓踩踏永遠觸發不了 auto-start。
        if (gameStore.isPaused && gameStore.currentRideId !== null) return;
        const { profile, data } = msg;
        if (profile === 'HR') {
          sensorStore.updateHr(parseHrData(data));
        } else if (profile === 'SC' || profile === 'SPD' || profile === 'CAD') {
          sensorStore.updateSc(parseScData(data));
        } else if (profile === 'PWR') {
          sensorStore.updatePwr(parsePwrData(data));
        }
      } else if (msg.type === 'game_state') {
        // Buffered even while paused — the store needs paused/elapsed frames
        // to keep the HUD clock and pause overlay state honest.
        gameStateStore.push(msg);
      } else if (msg.type === 'status') {
        sensorStore.updateStatus(msg);
      }
    } catch {
      // ignore malformed messages
    }
  }

  function connect() {
    if (disposed) return;
    cleanup();

    status.value = 'connecting';
    lastError.value = null;

    try {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws/live`);
    } catch (e) {
      status.value = 'disconnected';
      lastError.value = String(e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      status.value = 'connected';
      backoff = 1000;
    };

    ws.onmessage = handleMessage;

    ws.onclose = () => {
      status.value = 'disconnected';
      sensorStore.updateStatus({ state: 'idle', sensors: [], rideId: null });
      scheduleReconnect();
    };

    ws.onerror = (e) => {
      lastError.value = 'WebSocket error';
      // onclose will fire after onerror
    };
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, 10000);
      connect();
    }, backoff);
  }

  function disconnect() {
    disposed = true;
    cleanup();
    status.value = 'disconnected';
  }

  function cleanup() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      ws = null;
    }
  }

  onUnmounted(() => {
    disconnect();
  });

  return { status, lastError, connect, disconnect };
}
