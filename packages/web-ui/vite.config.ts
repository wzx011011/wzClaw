import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 本地开发时代理 /api 到 agent-server
      '/api': {
        target: 'http://localhost:8082',
        changeOrigin: true,
      },
    },
  },
  define: {
    // 默认 WebSocket 连接地址，可在 .env.local 中覆盖
    __VITE_AGENT_URL__: JSON.stringify(
      process.env.VITE_AGENT_URL ?? 'ws://localhost:8082'
    ),
  },
})
