<template>
  <el-drawer
    :model-value="open"
    direction="btt"
    size="100%"
    :with-header="false"
    :append-to-body="true"
    @close="emit('close')"
  >
    <div class="tpl-editor__header">
      <h3>
        <font-awesome-icon icon="comment-dots" />
        Message Templates
      </h3>
      <el-button circle @click="emit('close')">
        <font-awesome-icon icon="xmark" />
      </el-button>
    </div>

    <div class="tpl-editor__body">
      <p class="tpl-editor__hint">
        Each event type has a base template. You can add custom variants below.
        In-game, a random variant is picked. Use <code v-pre>{placeholder}</code> for dynamic values.
      </p>

      <div
        v-for="type in messageTypes"
        :key="type.id"
        class="tpl-card"
      >
        <div class="tpl-card__header">
          <span class="tpl-card__icon" :style="{ color: type.color }">
            <font-awesome-icon :icon="type.icon" />
          </span>
          <span class="tpl-card__id">{{ type.id }}</span>
          <span class="tpl-card__base">{{ type.baseTemplate }}</span>
          <span v-if="type.placeholders.length" class="tpl-card__placeholders">
            {{ formatPlaceholders(type.placeholders) }}
          </span>
        </div>

        <div class="tpl-card__variants">
          <div
            v-for="(v, idx) in variantsMap[type.id] ?? []"
            :key="v.id"
            class="tpl-card__variant"
          >
            <el-input
              v-model="v.template"
              size="small"
              :placeholder="type.baseTemplate"
              @change="saveVariant(type.id)"
            />
            <el-button
              size="small"
              type="danger"
              circle
              @click="removeVariant(type.id, idx)"
            >
              <font-awesome-icon icon="trash" />
            </el-button>
          </div>

          <el-button
            size="small"
            class="tpl-card__add"
            @click="addVariant(type.id)"
          >
            <font-awesome-icon icon="plus" />
            Add Variant
          </el-button>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { watch, reactive } from 'vue';
import { GAME_MESSAGE_TYPES } from '@littlecycling/shared';
import { notifyError } from '@/utils/notify';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

interface VariantRow {
  id: number;
  template: string;
}

const messageTypes = Object.values(GAME_MESSAGE_TYPES);

function formatPlaceholders(placeholders: string[]): string {
  return placeholders.map((p) => '{' + p + '}').join(' ');
}
const variantsMap = reactive<Record<string, VariantRow[]>>({});

async function loadAllVariants(): Promise<void> {
  try {
    const res = await fetch('/api/messages/variants');
    if (!res.ok) return;
    const { counts } = await res.json() as { counts: { typeId: string; count: number }[] };

    // Clear existing data
    for (const key of Object.keys(variantsMap)) delete variantsMap[key];

    for (const { typeId } of counts) {
      const r = await fetch(`/api/messages/variants/${typeId}`);
      if (r.ok) {
        const { variants } = await r.json() as { variants: VariantRow[] };
        variantsMap[typeId] = variants;
      }
    }
  } catch {
    notifyError('Failed to load message variants');
  }
}

// Reload when drawer opens
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) loadAllVariants();
  },
);

function addVariant(typeId: string): void {
  if (!variantsMap[typeId]) variantsMap[typeId] = [];
  variantsMap[typeId].push({ id: -Date.now(), template: '' });
}

function removeVariant(typeId: string, idx: number): void {
  variantsMap[typeId]?.splice(idx, 1);
  saveVariant(typeId);
}

async function saveVariant(typeId: string): Promise<void> {
  const variants = variantsMap[typeId] ?? [];
  const templates = variants.map((v) => v.template).filter((t) => t.trim().length > 0);

  try {
    await fetch(`/api/messages/variants/${typeId}`, { method: 'DELETE' });
    if (templates.length > 0) {
      await fetch(`/api/messages/variants/${typeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templates }),
      });
    }
  } catch {
    notifyError('Failed to save variants');
  }
}
</script>

<style scoped>
:deep(.el-drawer) {
  background: var(--surface) !important;
}

:deep(.el-drawer__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.tpl-editor__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hud-border-bright);
  position: relative;
}

.tpl-editor__header::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
  opacity: 0.5;
}

.tpl-editor__header h3 {
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

.tpl-editor__header :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-cyan);
  border-radius: 0;
}

.tpl-editor__body {
  padding: 16px 20px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tpl-editor__hint {
  font-size: 12px;
  color: var(--hud-text);
  line-height: 1.5;
}

.tpl-editor__hint code {
  background: rgba(0, 229, 255, 0.1);
  padding: 1px 4px;
  border-radius: 2px;
  color: var(--hud-cyan);
  font-size: 11px;
}

.tpl-card {
  border: 1px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  padding: 12px 16px;
  background: rgba(0,229,255,0.02);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tpl-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tpl-card__icon {
  font-size: 14px;
  filter: drop-shadow(0 0 4px currentColor);
}

.tpl-card__id {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.tpl-card__base {
  font-size: 12px;
  color: var(--hud-text);
  opacity: 0.7;
}

.tpl-card__placeholders {
  font-size: 10px;
  color: var(--hud-yellow, #fcee09);
  font-family: monospace;
}

.tpl-card__variants {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 22px;
}

.tpl-card__variant {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tpl-card__variant :deep(.el-input) {
  flex: 1;
}

.tpl-card__add {
  align-self: flex-start;
  font-size: 11px;
}
</style>
