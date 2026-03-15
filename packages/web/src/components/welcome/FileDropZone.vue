<template>
  <div
    class="drop-zone"
    :class="{ 'drop-zone--active': isDragging }"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop.prevent="handleDrop"
    @click="openFilePicker"
  >
    <font-awesome-icon icon="upload" class="drop-zone__icon" />
    <span class="drop-zone__text">Upload GPX / TCX / FIT</span>
    <span class="drop-zone__hint">drag & drop or click</span>
    <input
      ref="fileInput"
      type="file"
      accept=".gpx,.tcx,.fit"
      class="drop-zone__input"
      @change="handleFileInput"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{
  'file-loaded': [fileName: string, content: string | ArrayBuffer];
}>();

const isDragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function openFilePicker() {
  fileInput.value?.click();
}

function handleDrop(e: DragEvent) {
  isDragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
}

function handleFileInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) readFile(file);
  input.value = '';
}

function readFile(file: File) {
  const isFit = file.name.toLowerCase().endsWith('.fit');
  const reader = new FileReader();
  reader.onload = () => {
    if (reader.result != null) {
      emit('file-loaded', file.name, reader.result);
    }
  };
  if (isFit) {
    reader.readAsArrayBuffer(file);
  } else {
    reader.readAsText(file);
  }
}
</script>

<style scoped>
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  border: 1px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  cursor: pointer;
  transition: background 0.2s, filter 0.2s;
  background: rgba(0,229,255,0.02);
}

.drop-zone:hover,
.drop-zone--active {
  background: rgba(0,229,255,0.06);
  filter: drop-shadow(0 0 6px rgba(0,229,255,0.4));
}

.drop-zone__icon {
  font-size: 24px;
  color: var(--hud-cyan);
  filter: drop-shadow(0 0 6px rgba(0,229,255,0.5));
}

.drop-zone__text {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  color: var(--hud-text-bright);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.drop-zone__hint {
  font-size: 10px;
  color: var(--hud-text);
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.drop-zone__input {
  display: none;
}
</style>
