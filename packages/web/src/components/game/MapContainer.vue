<template>
  <div ref="container" class="map-container"></div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const container = ref<HTMLElement | null>(null);

defineExpose({ container });
</script>

<style scoped>
.map-container {
  width: 100vw;
  height: 100vh;
}
</style>
