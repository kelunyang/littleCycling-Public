import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({ resolvers: [ElementPlusResolver()] }),
    Components({ resolvers: [ElementPlusResolver()] }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/three/')) return 'vendor-three';
            if (id.includes('/phaser/')) return 'vendor-phaser';
            if (id.includes('/maplibre-gl/')) return 'vendor-maplibre';
            if (id.includes('/@fortawesome/')) return 'vendor-fontawesome';
            if (
              id.includes('/vue/') ||
              id.includes('/@vue/') ||
              id.includes('/vue-router/') ||
              id.includes('/pinia/')
            )
              return 'vendor-vue';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${process.env.VITE_WS_PORT || 8765}`,
      '/ws': {
        target: `ws://localhost:${process.env.VITE_WS_PORT || 8765}`,
        ws: true,
      },
    },
  },
});
