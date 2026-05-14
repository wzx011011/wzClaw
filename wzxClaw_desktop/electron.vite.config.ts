import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// web-ui 包路径（packages/web-ui/ 相对于 wzxClaw_desktop/）
const webUiRoot = resolve(__dirname, '../packages/web-ui')

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          'uuid',
          'openai',
          '@anthropic-ai/sdk',
          'zustand',
          'dotenv',
          'zod'
        ]
      })
    ],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    // 指向 packages/web-ui/ 作为 renderer 根目录
    // electron-vite 默认 root 为 './src/renderer'，这里覆盖为 web-ui
    root: webUiRoot,
    resolve: {
      alias: {
        // web-ui 使用 '@' 作为 src 别名
        '@': resolve(webUiRoot, 'src'),
      }
    },
    plugins: [react()],
    build: {
      // 输出目录不变，仍然放在 out/renderer
      outDir: resolve(__dirname, 'out/renderer'),
      base: './',
      rollupOptions: {
        // 显式指定 web-ui 的 index.html 作为入口
        input: resolve(webUiRoot, 'index.html'),
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
      // 默认 WebSocket 连接地址（web-ui 需要，本地模式不使用此值）
      __VITE_AGENT_URL__: JSON.stringify(
        process.env.VITE_AGENT_URL ?? 'ws://localhost:8082'
      ),
    },
  }
})
