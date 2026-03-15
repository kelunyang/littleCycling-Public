import { ref, onUnmounted } from 'vue';
import { useSensorStore } from '@/stores/sensorStore';
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
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let disposed = false;

  function handleMessage(event: MessageEvent) {
    try {
      const msg = JSON.parse(event.data) as WsMessage;

      if (msg.type === 'sensor') {
        const { profile, data } = msg;
        if (profile === 'HR') {
          sensorStore.updateHr(parseHrData(data));
        } else if (profile === 'SC' || profile === 'SPD' || profile === 'CAD') {
          sensorStore.updateSc(parseScData(data));
        } else if (profile === 'PWR') {
          sensorStore.updatePwr(parsePwrData(data));
        }
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
