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
  build: {
    // 输出目录
    outDir: 'dist',
    // 可部署到任意路径
    base: './',
    // chunk 分割策略
    rollupOptions: {
      output: {
        manualChunks: {
          // React 核心
          'vendor-react': ['react', 'react-dom'],
          // 状态管理
          'vendor-zustand': ['zustand'],
          // Markdown 渲染
          'vendor-markdown': ['react-markdown', 'remark-gfm', 'rehype-raw'],
          // 代码高亮
          'vendor-highlight': ['highlight.js'],
        },
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
