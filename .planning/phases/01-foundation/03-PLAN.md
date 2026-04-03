---
plan: 01-03
phase: 01
wave: 2
depends_on: ["01", "02"]
status: pending
requirements_addressed: [ELEC-02]
files_modified:
  - src/preload/index.ts
  - src/main/index.ts
  - src/main/ipc-handlers.ts
  - src/preload/__tests__/preload.test.ts
autonomous: true
---

# Plan 01-03: IPC Protocol + Integration Verification

<objective>
Wire up the typed IPC bridge between Main and Renderer processes using Electron's contextBridge. Implement IPC handlers in main process that can receive messages from renderer and send streaming events back. Verify the full Phase 1 stack compiles and the dev server starts.
</objective>

<must_haves>
- Main process and renderer can exchange typed messages through IPC channels without runtime type errors
- Preload script exposes typed API surface via contextBridge
- Zod validation on IPC boundaries
- electron-vite build passes
- Dev server starts and opens a window
</must_haves>

## Tasks

<task type="auto">
  <id>01-03-01</id>
  <title>Implement typed preload script with contextBridge</title>
  <read_first>
    - src/shared/ipc-channels.ts (channel names and payload types)
    - src/shared/types.ts (message and event types)
    - .planning/phases/01-foundation/01-CONTEXT.md (D-08, D-09, D-10, D-11)
    - .planning/phases/01-foundation/01-RESEARCH.md (Pattern 4: Type-Safe IPC)
  </read_first>
  <action>
    Replace `src/preload/index.ts` with typed IPC bridge:

    ```typescript
    import { contextBridge, ipcRenderer } from 'electron'
    import type { WzxClawAPI } from '../shared/ipc-channels'

    const api: WzxClawAPI = {
      // Agent
      sendMessage: (request) => ipcRenderer.invoke('agent:send_message', request),
      stopGeneration: () => ipcRenderer.invoke('agent:stop'),

      // Stream listeners — return unsubscribe functions
      onStreamText: (callback) => {
        const handler = (_: unknown, payload: { content: string }) => callback(payload)
        ipcRenderer.on('stream:text_delta', handler)
        return () => ipcRenderer.removeListener('stream:text_delta', handler)
      },
      onStreamToolStart: (callback) => {
        const handler = (_: unknown, payload: { id: string; name: string }) => callback({ conversationId: '', ...payload })
        ipcRenderer.on('stream:tool_use_start', handler)
        return () => ipcRenderer.removeListener('stream:tool_use_start', handler)
      },
      onStreamToolResult: (callback) => {
        const handler = (_: unknown, payload: { id: string; output: string; isError: boolean }) => callback({ conversationId: '', toolUseId: payload.id, ...payload })
        ipcRenderer.on('stream:tool_use_end', handler)
        return () => ipcRenderer.removeListener('stream:tool_use_end', handler)
      },
      onStreamEnd: (callback) => {
        const handler = (_: unknown, payload: { usage: { inputTokens: number; outputTokens: number } }) => callback({ conversationId: '', ...payload })
        ipcRenderer.on('stream:done', handler)
        return () => ipcRenderer.removeListener('stream:done', handler)
      },
      onStreamError: (callback) => {
        const handler = (_: unknown, payload: { error: string }) => callback({ conversationId: '', ...payload })
        ipcRenderer.on('stream:error', handler)
        return () => ipcRenderer.removeListener('stream:error', handler)
      },

      // Files (stubs for Phase 3)
      openFile: (request) => ipcRenderer.invoke('file:open', request),
      saveFile: (request) => ipcRenderer.invoke('file:save', request),
      onFileChanged: (callback) => {
        const handler = (_: unknown, payload: { path: string; content: string }) => callback(payload)
        ipcRenderer.on('file:changed', handler)
        return () => ipcRenderer.removeListener('file:changed', handler)
      },

      // Settings
      getSettings: () => ipcRenderer.invoke('settings:get'),
      updateSettings: (request) => ipcRenderer.invoke('settings:update', request),
    }

    contextBridge.exposeInMainWorld('wzxclaw', api)

    // Also expose electron API for devtools access
    if (process.env.NODE_ENV === 'development') {
      contextBridge.exposeInMainWorld('electron', {
        ipcRenderer: {
          send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
        },
      })
    }
    ```
  </action>
  <acceptance_criteria>
    - `src/preload/index.ts` calls `contextBridge.exposeInMainWorld('wzxclaw', api)`
    - `api` object has methods: sendMessage, stopGeneration, onStreamText, onStreamEnd, openFile, saveFile, getSettings, updateSettings
    - All stream listener methods return unsubscribe functions `() => void`
    - `sendMessage` uses `ipcRenderer.invoke('agent:send_message', request)`
    - File uses proper type from `WzxClawAPI` interface
    - `npx tsc --noEmit` passes
  </acceptance_criteria>
  <automated>grep "contextBridge.exposeInMainWorld" src/preload/index.ts</automated>
</task>

<task type="auto">
  <id>01-03-02</id>
  <title>Implement IPC handlers in main process</title>
  <read_first>
    - src/main/index.ts (current main process entry)
    - src/shared/ipc-channels.ts (channel names and Zod schemas)
    - src/shared/types.ts (message types)
    - .planning/phases/01-foundation/01-CONTEXT.md (D-09 Zod validation)
  </read_first>
  <action>
    Create `src/main/ipc-handlers.ts`:

    ```typescript
    import { ipcMain, BrowserWindow } from 'electron'
    import { IPC_CHANNELS, IpcSchemas } from '../shared/ipc-channels'
    import type { LLMGateway } from './llm/gateway'
    import type { ProviderConfig } from './llm/types'

    // In-memory settings for Phase 1 (Phase 4 adds persistence)
    let currentSettings = {
      provider: 'openai' as string,
      model: 'gpt-4o',
      hasApiKey: false,
      baseURL: undefined as string | undefined,
      systemPrompt: undefined as string | undefined,
    }

    // Store API keys in memory (Phase 4 uses safeStorage)
    const apiKeys = new Map<string, string>()

    export function registerIpcHandlers(gateway: LLMGateway): void {
      // Agent: send message
      ipcMain.handle(IPC_CHANNELS['agent:send_message'], async (event, request) => {
        // Validate with Zod
        const result = IpcSchemas['agent:send_message'].request.safeParse(request)
        if (!result.success) {
          throw new Error(`Invalid request: ${result.error.message}`)
        }

        const sender = event.sender

        // For Phase 1: just stream a test response to verify IPC works
        // Phase 2 replaces this with actual agent loop
        try {
          const testConfig: ProviderConfig = {
            provider: currentSettings.provider as 'openai' | 'anthropic',
            apiKey: apiKeys.get(currentSettings.provider) || '',
            baseURL: currentSettings.baseURL,
          }

          // Send a simple test message through gateway
          for await (const streamEvent of gateway.stream({
            model: currentSettings.model,
            messages: [{ role: 'user', content: result.data.content }],
            systemPrompt: currentSettings.systemPrompt,
          })) {
            switch (streamEvent.type) {
              case 'text_delta':
                sender.send(IPC_CHANNELS['stream:text_delta'], { content: streamEvent.content })
                break
              case 'tool_use_start':
                sender.send(IPC_CHANNELS['stream:tool_use_start'], { id: streamEvent.id, name: streamEvent.name })
                break
              case 'tool_use_end':
                sender.send(IPC_CHANNELS['stream:tool_use_end'], { id: streamEvent.id, parsedInput: streamEvent.parsedInput })
                break
              case 'error':
                sender.send(IPC_CHANNELS['stream:error'], { error: streamEvent.error })
                break
              case 'done':
                sender.send(IPC_CHANNELS['stream:done'], { usage: streamEvent.usage })
                break
            }
          }
        } catch (error) {
          sender.send(IPC_CHANNELS['stream:error'], {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })

      // Agent: stop
      ipcMain.handle(IPC_CHANNELS['agent:stop'], () => {
        // Phase 2 implements AbortController cancellation
        return
      })

      // Settings: get
      ipcMain.handle(IPC_CHANNELS['settings:get'], () => {
        return currentSettings
      })

      // Settings: update
      ipcMain.handle(IPC_CHANNELS['settings:update'], (_event, request) => {
        if (request.provider) currentSettings.provider = request.provider
        if (request.model) currentSettings.model = request.model
        if (request.apiKey) {
          apiKeys.set(currentSettings.provider, request.apiKey)
          currentSettings.hasApiKey = true
        }
        if (request.baseURL !== undefined) currentSettings.baseURL = request.baseURL
        if (request.systemPrompt !== undefined) currentSettings.systemPrompt = request.systemPrompt
      })
    }
    ```

    Update `src/main/index.ts` to register IPC handlers:

    ```typescript
    import { app, BrowserWindow } from 'electron'
    import { join } from 'path'
    import { electronApp, optimizer, is } from '@electron-toolkit/utils'
    import { LLMGateway } from './llm/gateway'
    import { registerIpcHandlers } from './ipc-handlers'

    const gateway = new LLMGateway()

    function createWindow(): BrowserWindow {
      const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          sandbox: false,
        },
      })

      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
      } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
      }

      return mainWindow
    }

    app.whenReady().then(() => {
      electronApp.setAppUserModelId('com.wzxclaw')

      // Register IPC handlers with gateway
      registerIpcHandlers(gateway)

      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      createWindow()

      app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit()
      }
    })
    ```
  </action>
  <acceptance_criteria>
    - `src/main/ipc-handlers.ts` exports `registerIpcHandlers` function
    - `registerIpcHandlers` registers handlers for: agent:send_message, agent:stop, settings:get, settings:update
    - agent:send_message validates request with Zod before processing
    - Stream events forwarded to renderer via `sender.send()` with correct channel names
    - `src/main/index.ts` imports and calls `registerIpcHandlers(gateway)` after app.whenReady()
    - `src/main/index.ts` creates LLMGateway instance at module level
    - `npx tsc --noEmit` passes
  </acceptance_criteria>
  <automated>grep 'registerIpcHandlers' src/main/index.ts && grep 'registerIpcHandlers' src/main/ipc-handlers.ts</automated>
</task>

<task type="auto">
  <id>01-03-03</id>
  <title>Integration verification — build + dev server</title>
  <read_first>
    - electron.vite.config.ts
    - package.json
    - tsconfig.json
  </read_first>
  <action>
    1. Run TypeScript compilation check:
       ```bash
       npx tsc --noEmit
       ```

    2. Run electron-vite build to verify all three targets compile:
       ```bash
       npx electron-vite build
       ```

    3. Run all tests:
       ```bash
       npx vitest run
       ```

    4. If TypeScript errors occur:
       - Check that `src/shared/` is included in all tsconfig paths
       - Ensure path aliases work in `electron.vite.config.ts`
       - Add `"paths": { "@shared/*": ["./src/shared/*"] }` to tsconfig files if needed

    5. If build errors occur:
       - Verify `electron.vite.config.ts` has correct entry points for main, preload, renderer
       - Ensure preload resolves `../shared/` correctly
       - Check that Zod and uuid are bundled correctly

    6. Add `src/shared/index.ts` barrel export:
       ```typescript
       export * from './types'
       export * from './ipc-channels'
       export * from './constants'
       ```

    7. Verify dev server can start:
       ```bash
       npm run dev
       ```
       Note: This starts Electron. For CI, just verify the build succeeds. The dev server test is manual.
  </action>
  <acceptance_criteria>
    - `npx tsc --noEmit` passes with zero errors
    - `npx electron-vite build` produces output in `dist/` directory
    - `npx vitest run` passes all tests
    - `dist/main/` directory exists after build
    - `dist/preload/` directory exists after build
    - `dist/renderer/` directory exists after build
    - `src/shared/index.ts` exists as barrel export
  </acceptance_criteria>
  <automated>npx electron-vite build 2>&1 | tail -10 && npx vitest run 2>&1 | tail -5</automated>
</task>

<verification>
1. `npx vitest run` — all tests pass (shared types + LLM gateway + IPC)
2. `npx tsc --noEmit` — zero type errors across all tsconfigs
3. `npx electron-vite build` — produces dist/ output for all three targets
4. Manual: `npm run dev` — Electron window opens
</verification>

<success_criteria>
- Typed IPC bridge between main and renderer via contextBridge
- Zod validation on agent:send_message boundary
- Main process IPC handlers forward stream events to renderer
- LLMGateway wired into main process entry point
- Full Phase 1 stack compiles without errors
- Dev server starts and opens Electron window
</success_criteria>

<output>
After completion, create `.planning/phases/01-foundation/03-SUMMARY.md`
</output>
