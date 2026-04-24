import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { IPC_CHANNELS, IpcSchemas } from '../ipc-channels'
import { FileMentionSchema } from '../types'

// ============================================================
// IPC Wiring Alignment Tests
// 验证 preload 和 main 中使用的 channel 字符串与 IPC_CHANNELS 定义一致
// ============================================================

const ROOT = path.resolve(__dirname, '../../..')

/** 从源文件中提取 ipcRenderer.invoke/on/send 的 channel 字符串 */
function extractPreloadChannels(filePath: string): Set<string> {
  const src = fs.readFileSync(filePath, 'utf-8')
  const channels = new Set<string>()
  // ipcRenderer.invoke('channel', ...) / ipcRenderer.on('channel', ...) / ipcRenderer.send('channel', ...)
  const re = /ipcRenderer\.(?:invoke|on|send)\(\s*'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    channels.add(m[1])
  }
  return channels
}

/** 从源文件中提取 ipcMain.handle/on 和 .send() 使用的 channel 字符串 */
function extractMainChannels(filePaths: string[]): Set<string> {
  const channels = new Set<string>()
  for (const filePath of filePaths) {
    const src = fs.readFileSync(filePath, 'utf-8')
    // ipcMain.handle(IPC_CHANNELS['channel'], ...) 或 ipcMain.handle('channel', ...)
    // ipcMain.on(IPC_CHANNELS['channel'], ...) 或 ipcMain.on('channel', ...)
    // sender.send(IPC_CHANNELS['channel'], ...) 或 .send('channel', ...)
    // webContents.send(IPC_CHANNELS['channel'], ...) 或 webContents.send('channel', ...)
    const patterns = [
      // ipcMain.handle('channel') 或 ipcMain.handle(IPC_CHANNELS['channel'])
      /ipcMain\.(?:handle|on)\(\s*(?:IPC_CHANNELS\['([^']+)'\]|'([^']+)')/g,
      // sender.send / wc.send / webContents.send
      /\.send\(\s*(?:IPC_CHANNELS\['([^']+)'\]|'([^']+)')/g,
    ]
    for (const re of patterns) {
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        channels.add(m[1] || m[2])
      }
    }
  }
  return channels
}

describe('IPC_CHANNELS', () => {
  it('has all required channel names', () => {
    expect(IPC_CHANNELS['agent:send_message']).toBe('agent:send_message')
    expect(IPC_CHANNELS['agent:stop']).toBe('agent:stop')
    expect(IPC_CHANNELS['stream:text_delta']).toBe('stream:text_delta')
    expect(IPC_CHANNELS['stream:done']).toBe('stream:done')
    expect(IPC_CHANNELS['settings:get']).toBe('settings:get')
    expect(IPC_CHANNELS['settings:update']).toBe('settings:update')
  })

  it('all channel names are const (readonly)', () => {
    // Type-level check: values should be string literals, not string
    const channel: 'agent:send_message' = IPC_CHANNELS['agent:send_message']
    expect(channel).toBe('agent:send_message')
  })
})

describe('IpcSchemas', () => {
  it('validates send_message request', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      conversationId: 'conv-123',
      content: 'Hello agent'
    })
    expect(result.success).toBe(true)
  })

  it('rejects send_message with empty content', () => {
    const result = IpcSchemas['agent:send_message'].request.safeParse({
      conversationId: 'conv-123',
      content: ''
    })
    expect(result.success).toBe(false)
  })

  it('validates stream:text_delta payload', () => {
    const result = IpcSchemas['stream:text_delta'].safeParse({
      content: 'hello token'
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================
// @-mention file injection tests (MENTION-01 through MENTION-06)
// ============================================================

describe('FileMention type', () => {
  it('has type=file_mention, path, content, size fields', () => {
    const mention = {
      type: 'file_mention' as const,
      path: 'src/utils/helpers.ts',
      content: 'export function add(a: number, b: number) { return a + b; }',
      size: 56
    }
    const result = FileMentionSchema.safeParse(mention)
    expect(result.success).toBe(true)
  })

  it('rejects missing type field', () => {
    const result = FileMentionSchema.safeParse({
      path: 'src/foo.ts',
      content: 'hello',
      size: 5
    })
    expect(result.success).toBe(false)
  })

  it('rejects wrong type value', () => {
    const result = FileMentionSchema.safeParse({
      type: 'mention',
      path: 'src/foo.ts',
      content: 'hello',
      size: 5
    })
    expect(result.success).toBe(false)
  })
})

describe('file:read-content IPC channel', () => {
  it('has file:read-content channel registered', () => {
    expect(IPC_CHANNELS['file:read-content']).toBe('file:read-content')
  })

  it('validates file:read-content request schema', () => {
    const schema = IpcSchemas['file:read-content']
    const result = schema.request.safeParse({
      filePath: 'src/utils/helpers.ts'
    })
    expect(result.success).toBe(true)
  })

  it('rejects file:read-content request without filePath', () => {
    const schema = IpcSchemas['file:read-content']
    const result = schema.request.safeParse({})
    expect(result.success).toBe(false)
  })

  it('validates file:read-content response with content, size, path', () => {
    const schema = IpcSchemas['file:read-content']
    const result = schema.response.safeParse({
      content: 'hello world',
      size: 11,
      path: 'src/foo.ts'
    })
    expect(result.success).toBe(true)
  })

  it('validates file:read-content error response for file too large', () => {
    const schema = IpcSchemas['file:read-content']
    const result = schema.response.safeParse({
      error: 'File too large',
      size: 200000,
      limit: 102400
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================
// IPC Wiring Alignment — 静态分析：preload ↔ IPC_CHANNELS ↔ main
// ============================================================

describe('IPC wiring alignment', () => {
  const definedChannels = new Set(Object.keys(IPC_CHANNELS))
  const preloadChannels = extractPreloadChannels(path.join(ROOT, 'src/preload/index.ts'))
  const mainChannels = extractMainChannels([
    path.join(ROOT, 'src/main/ipc-handlers.ts'),
    path.join(ROOT, 'src/main/index.ts'),
    path.join(ROOT, 'src/main/permission/permission-manager.ts'),
    path.join(ROOT, 'src/main/agent/agent-loop.ts'),
    path.join(ROOT, 'src/main/agent/turn-manager.ts'),
  ])

  it('every preload channel exists in IPC_CHANNELS', () => {
    const missing = [...preloadChannels].filter(c => !definedChannels.has(c))
    expect(missing, `preload 使用了但 IPC_CHANNELS 中未定义的 channel:\n${missing.join('\n')}`).toEqual([])
  })

  it('every main ipcMain.handle/on channel exists in IPC_CHANNELS', () => {
    // 从 main 提取的是 .send + handle/on 的混合集，需区分
    // ipcMain.handle/on 用 IPC_CHANNELS['xxx'] 或 'xxx' — 这里统一检查
    const missing = [...mainChannels].filter(c => !definedChannels.has(c))
    expect(missing, `main 使用了但 IPC_CHANNELS 中未定义的 channel:\n${missing.join('\n')}`).toEqual([])
  })

  it('every IPC_CHANNELS definition is used in at least preload or main', () => {
    const allUsed = new Set([...preloadChannels, ...mainChannels])
    const unused = [...definedChannels].filter(c => !allUsed.has(c))
    expect(unused, `IPC_CHANNELS 中定义但从未使用的 channel（死代码）:\n${unused.join('\n')}`).toEqual([])
  })

  it('preload and main share the same channel set for invoke/handle pairs', () => {
    // invoke/handle 对应当完全匹配
    // 提取 preload 中 invoke 用的 channel
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf-8')
    const invokeChannels = new Set<string>()
    const invokeRe = /ipcRenderer\.invoke\(\s*'([^']+)'/g
    let m: RegExpExecArray | null
    while ((m = invokeRe.exec(preloadSrc)) !== null) {
      invokeChannels.add(m[1])
    }

    // 提取 main 中 ipcMain.handle 用的 channel（从 IPC_CHANNELS 引用和裸字符串两种）
    const mainSrcs = [
      path.join(ROOT, 'src/main/ipc-handlers.ts'),
      path.join(ROOT, 'src/main/index.ts'),
    ]
    const handleChannels = new Set<string>()
    for (const f of mainSrcs) {
      const src = fs.readFileSync(f, 'utf-8')
      const handleRe = /ipcMain\.handle\(\s*(?:IPC_CHANNELS\['([^']+)'\]|'([^']+)')/g
      let hm: RegExpExecArray | null
      while ((hm = handleRe.exec(src)) !== null) {
        handleChannels.add(hm[1] || hm[2])
      }
    }

    // invoke 但无 handle = preload 发出但 main 不处理
    // 已知例外：agent:permission_response 使用 ipcMain.handleOnce() 动态注册
    const knownDynamicHandles = new Set(['agent:permission_response'])
    const noHandler = [...invokeChannels].filter(c => !handleChannels.has(c) && !knownDynamicHandles.has(c))
    expect(noHandler, `preload invoke 但 main 无 handle 的 channel:\n${noHandler.join('\n')}`).toEqual([])

    // handle 但无 invoke = main 处理但 preload 不发出（可能由 mobile relay 触发，不一定是 bug）
    // 注意：这里只做 informational，不强制失败，因为有些 handle 是给 mobile relay 用的
    const noInvoker = [...handleChannels].filter(c => !invokeChannels.has(c))
    // 如果希望严格，取消下面注释：
    // expect(noInvoker, `main handle 但 preload 无 invoke 的 channel:\n${noInvoker.join('\n')}`).toEqual([])
    // 宽松模式：仅记录数量，不失败
    expect(noInvoker.length).toBeLessThanOrEqual(10) // 防止大量新增未注册的 handle
  })
})
