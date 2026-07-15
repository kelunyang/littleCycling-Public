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
    // 若 5173 被殘留的 node.exe 佔住,直接報錯而不是默默跳號——
    // 這樣才會發現上一次 dev 沒關乾淨(見 dev-runner 的 killTree)。
    strictPort: true,
    // Vite runs on Windows watching the F: drive, but edits made from WSL don't
    // reliably fire Windows file-change notifications. Poll instead so HMR
    // always catches saves. Costs a little CPU; drop it if you edit on Windows.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.VITE_WS_PORT || 8765}`,
        // localhost 上多個 dev 專案的 cookie 全掛在同一個 domain,累積超過
        // Node 的 16KB header 上限時,Fastify 會在 socket 層直接回
        // 400 {"message":"Client Error"}(clientErrorHandler)。本專案完全
        // 不用 cookie,轉發前剝掉,徹底絕緣其他專案的 cookie 膨脹。
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('cookie');
          });
        },
      },
      '/ws': {
        target: `ws://localhost:${process.env.VITE_WS_PORT || 8765}`,
        ws: true,
      },
    },
  },
});
