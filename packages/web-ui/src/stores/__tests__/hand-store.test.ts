// ============================================================
// hand-store 单元测试 — 验证 Hand 列表鉴权与状态更新
// ============================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useHandStore } from '../hand-store'

describe('useHandStore', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useHandStore.setState({ hands: [], selectedHandId: null, loading: false })
  })

  it('fetchHands 请求 /admin/hands 时携带 Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([
        { id: 'desktop-hand-1', type: 'desktop', capabilities: ['FileRead'], priority: 10, lastHeartbeat: 123 },
      ]),
    })
    vi.stubGlobal('fetch', fetchMock)

    await useHandStore.getState().fetchHands('wss://agent.5945.top/', 'secret-token')

    expect(fetchMock).toHaveBeenCalledWith('https://agent.5945.top/admin/hands', {
      headers: { Authorization: 'Bearer secret-token' },
    })
    expect(useHandStore.getState().hands).toHaveLength(1)
    expect(useHandStore.getState().hands[0]!.id).toBe('desktop-hand-1')
  })
})
