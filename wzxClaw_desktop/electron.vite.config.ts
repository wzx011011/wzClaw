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
          '@wzxclaw/brain',
          '@wzxclaw/hand',
          'uuid',
          'openai',
          '@anthropic-ai/sdk',
          'zustand',
          'dotenv',
          'zod',
          'js-tiktoken',
        ]
      })
    ],
    resolve: {
      preserveSymlinks: true,
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
        input: resolve(webUiRoot, 'index.html'),
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
