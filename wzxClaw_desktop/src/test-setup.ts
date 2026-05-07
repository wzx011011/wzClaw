// ============================================================
// Vitest global setup — mock Electron for unit tests
// Tests run in plain Node.js without Electron installed.
// Any module that statically imports from 'electron' needs this stub.
// ============================================================

import { vi } from 'vitest'

// Mock Electron main-process APIs used across src/main/
vi.mock('electron', () => {
  const listeners = new Map<string, Set<Function>>()

  function getListeners(channel: string): Set<Function> {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    return listeners.get(channel)!
  }

  return {
    app: {
      getPath: (name: string) => {
        const paths: Record<string, string> = {
          userData: 'C:/Users/test/AppData/Roaming/wzxclaw',
          home: 'C:/Users/test',
          temp: 'C:/Users/test/AppData/Local/Temp',
          desktop: 'C:/Users/test/Desktop',
          documents: 'C:/Users/test/Documents',
        }
        return paths[name] ?? `C:/Users/test/${name}`
      },
      getName: () => 'wzxClaw',
      getVersion: () => '0.1.0-test',
      isPackaged: false,
      quit: vi.fn(),
      on: vi.fn(),
      whenReady: () => Promise.resolve(),
    },
    BrowserWindow: vi.fn().mockImplementation(() => ({
      loadURL: vi.fn(),
      webContents: {
        send: vi.fn(),
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
      },
      on: vi.fn(),
      once: vi.fn(),
      show: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false),
    })),
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn((channel: string, handler: Function) => {
        getListeners(channel).add(handler)
      }),
      removeHandler: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    },
    Menu: {
      setApplicationMenu: vi.fn(),
      buildFromTemplate: vi.fn(),
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(),
      showMessageBox: vi.fn(),
    },
    shell: {
      openPath: vi.fn(),
      openExternal: vi.fn(),
    },
    clipboard: {
      readText: vi.fn().mockReturnValue(''),
      writeText: vi.fn(),
    },
    nativeImage: {
      createFromPath: vi.fn(),
      createFromBuffer: vi.fn(),
      createEmpty: vi.fn(),
    },
    Notification: vi.fn().mockImplementation(() => ({
      show: vi.fn(),
      on: vi.fn(),
    })),
    screen: {
      getPrimaryDisplay: vi.fn().mockReturnValue({
        workAreaSize: { width: 1920, height: 1080 },
      }),
    },
    globalShortcut: {
      register: vi.fn(),
      unregister: vi.fn(),
    },
  }
})
