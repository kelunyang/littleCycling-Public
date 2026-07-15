<!--
  MarkdownView — 用 CDN 載入的 md-editor-v3 MdPreview 渲染繁中 Markdown。

  狀態機:loading（載入排版元件）/ ready（渲染）/ failed（降級純文字,離線仍可讀）。
  主題只吃語意 token,不寫死 hex（CLAUDE.md 規則）;背景保持透明,讓父容器的
  paper/HUD 底透出（避開 plastic 的 --hud-bg 陷阱）。
-->
<template>
  <div class="md-view">
    <component
      :is="MdPreview"
      v-if="state === 'ready' && MdPreview"
      :id="viewId"
      :model-value="content"
      :sanitize="sanitize"
      :no-mermaid="true"
      :no-katex="true"
      :show-code-row-number="false"
      preview-theme="default"
      :theme="mdTheme"
    />
    <div v-else-if="state === 'loading'" class="md-view__loading">
      <font-awesome-icon icon="spinner" spin />
      <span>載入排版元件…</span>
    </div>
    <pre v-else class="md-view__fallback">{{ content }}</pre>
  </div>
</template>

<script lang="ts">
// md-editor-v3 需要每個 editor 有唯一 id（多實例）。counter 必須放在普通
// <script>（module scope）——<script setup> 的頂層每個實例都會重跑,
// 放那裡每個實例都拿到 0,id 會重複。
let idCounter = 0;
</script>

<script setup lang="ts">
import { ref, computed, onMounted, markRaw, shallowRef, type Component } from 'vue';
import { useSettingsStore } from '@/stores/settingsStore';
import { loadMarkdownRenderer } from '@/utils/markdown-cdn';

defineProps<{ content: string }>();

const settingsStore = useSettingsStore();

const viewId = `md-view-${idCounter++}`;

const state = ref<'loading' | 'ready' | 'failed'>('loading');
const MdPreview = shallowRef<Component | null>(null);
const sanitize = ref<(html: string) => string>((html) => html);

// worldStyle 與 App.vue 同源（含 ?? 'plastic' 的預設,兩邊要一致）:
// plastic / cuphead → 淺色,其餘（cyberpunk 基底）→ 深色。
const mdTheme = computed<'light' | 'dark'>(() => {
  const ws = settingsStore.config.map.worldStyle ?? 'plastic';
  return ws === 'plastic' || ws === 'cuphead' ? 'light' : 'dark';
});

onMounted(async () => {
  try {
    const r = await loadMarkdownRenderer();
    MdPreview.value = markRaw(r.MdPreview);
    sanitize.value = r.sanitize;
    state.value = 'ready';
  } catch {
    state.value = 'failed';
  }
});
</script>

<style scoped>
.md-view {
  /* 覆寫 md-editor-v3 自身 CSS 變數,全部走語意 token,背景透明。 */
  --md-color: var(--hud-text);
  --md-bk-color: transparent;
  --md-border-color: var(--hud-border);
  color: var(--hud-text);
}

.md-view__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--hud-text-dim);
  padding: 8px 0;
}

.md-view__fallback {
  margin: 0;
  font-family: 'Consolas', 'Courier New', 'Noto Sans TC', monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--hud-text);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── md-editor-v3 預覽區覆寫（:deep 穿透 scoped）── */
.md-view :deep(.md-editor-preview-wrapper),
.md-view :deep(.md-editor-preview) {
  background: transparent;
  color: var(--hud-text);
  font-size: 13px;
  line-height: 1.7;
}

.md-view :deep(.md-editor-preview h1),
.md-view :deep(.md-editor-preview h2),
.md-view :deep(.md-editor-preview h3),
.md-view :deep(.md-editor-preview h4),
.md-view :deep(.md-editor-preview h5),
.md-view :deep(.md-editor-preview h6),
.md-view :deep(.md-editor-preview strong) {
  color: var(--hud-text-bright);
  border-bottom-color: var(--hud-border);
}

.md-view :deep(.md-editor-preview code),
.md-view :deep(.md-editor-preview pre) {
  background: rgba(var(--accent-rgb), 0.08);
  color: var(--hud-text);
}

.md-view :deep(.md-editor-preview a) {
  color: var(--hud-cyan);
}

.md-view :deep(.md-editor-preview blockquote) {
  border-left-color: var(--hud-border-bright);
  background: rgba(var(--accent-rgb), 0.04);
  color: var(--hud-text-dim);
}

.md-view :deep(.md-editor-preview hr) {
  border-top-color: var(--hud-border);
  background: var(--hud-border);
}

.md-view :deep(.md-editor-preview table),
.md-view :deep(.md-editor-preview th),
.md-view :deep(.md-editor-preview td) {
  border-color: var(--hud-border);
}

.md-view :deep(.md-editor-preview th) {
  background: rgba(var(--accent-rgb), 0.08);
  color: var(--hud-text-bright);
}

.md-view :deep(.md-editor-preview img) {
  max-width: 100%;
  height: auto;
}
</style>
