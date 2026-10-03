import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // dev convenience: Graph token from .env TOKEN, never baked into production builds
  const devToken = command === 'serve' ? (loadEnv(mode, process.cwd(), '').TOKEN ?? '') : ''

  return {
    plugins: [
      vue(),
      vueJsx(),
      vueDevTools(),
    ],
    css: {
      // 98.css ships an invalid `@media (not(hover))`, browsers drop it anyway
      lightningcss: { errorRecovery: true },
    },
    define: {
      __DEV_GRAPH_TOKEN__: JSON.stringify(devToken),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
  }
})
