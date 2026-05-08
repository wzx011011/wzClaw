// @vitest-environment jsdom
// 测试 ToolCard 的 accordion 动画和 shimmer 状态徽标
// 仅覆盖本次改动引入的两处变化：
//   1. .tool-status-text span 包裹状态标签
//   2. .tool-card-body 始终渲染（CSS 控制展开/折叠）
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import '@testing-library/jest-dom'

// ---- mock 外部依赖 ----------------------------------------
vi.mock('../../i18n/useT', () => ({
  useT: () => (key: string) => {
    // 返回 key 最后一段作为文字，例如 'toolCard.running' → 'running'
    return key.split('.').pop() ?? key
  },
}))

vi.mock('../../stores/diff-store', () => ({
  useDiffStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      addDiff: vi.fn(),
      setActiveDiff: vi.fn(),
      pendingDiffs: [],
    }),
}))

// window.wzxclaw 在 jsdom 里不存在，给个 stub 防止渲染崩溃
Object.assign(window, {
  wzxclaw: {
    revertFile: vi.fn().mockResolvedValue({ success: true }),
    openInEditor: vi.fn(),
  },
})

import ToolCard from '../chat/ToolCard'

function makeToolCall(
  overrides: Partial<{
    id: string
    name: string
    status: 'running' | 'completed' | 'error'
    input: Record<string, unknown>
    output: string
  }> = {}
) {
  return {
    id: 'tc-1',
    name: 'Read',
    status: 'completed' as const,
    ...overrides,
  }
}

// ============================================================
// 1. .tool-status-text span
// ============================================================
describe('ToolCard — status text span', () => {
  it('completed 状态：.tool-status-text 存在', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall()} />)
    expect(container.querySelector('.tool-status-text')).toBeInTheDocument()
  })

  it('running 状态：.tool-status-text 存在', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'running' })} />)
    expect(container.querySelector('.tool-status-text')).toBeInTheDocument()
  })

  it('error 状态：.tool-status-text 存在', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'error' })} />)
    expect(container.querySelector('.tool-status-text')).toBeInTheDocument()
  })

  it('.tool-status-text 内含状态文字（来自翻译 key 末段）', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall()} />)
    const span = container.querySelector('.tool-status-text')
    // useT mock 返回 key 末段 → 'completed'
    expect(span?.textContent).toBe('completed')
  })

  it('running 时 .tool-status-text 文字为 "running"', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'running' })} />)
    const span = container.querySelector('.tool-status-text')
    expect(span?.textContent).toBe('running')
  })
})

// ============================================================
// 2. .tool-card-body — 始终在 DOM 里（CSS 动画用）
// ============================================================
describe('ToolCard — accordion body always in DOM', () => {
  it('completed 工具：.tool-card-body 在 DOM 中（初始折叠）', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall()} />)
    expect(container.querySelector('.tool-card-body')).toBeInTheDocument()
  })

  it('running 工具：.tool-card-body 在 DOM 中（初始展开）', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'running' })} />)
    expect(container.querySelector('.tool-card-body')).toBeInTheDocument()
  })

  it('error 工具：.tool-card-body 在 DOM 中（初始展开）', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'error' })} />)
    expect(container.querySelector('.tool-card-body')).toBeInTheDocument()
  })
})

// ============================================================
// 3. .tool-card-body.expanded — 展开状态 class
// ============================================================
describe('ToolCard — accordion expanded class', () => {
  it('running 工具初始带 expanded class', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'running' })} />)
    expect(container.querySelector('.tool-card-body.expanded')).toBeInTheDocument()
  })

  it('completed 工具初始无 expanded class（折叠）', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'completed' })} />)
    expect(container.querySelector('.tool-card-body.expanded')).not.toBeInTheDocument()
  })

  it('error 工具初始带 expanded class', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'error' })} />)
    expect(container.querySelector('.tool-card-body.expanded')).toBeInTheDocument()
  })

  it('running → completed：useEffect 触发后折叠（移除 expanded）', () => {
    const running = makeToolCall({ status: 'running' })
    const { container, rerender } = render(<ToolCard toolCall={running} />)

    // 初始有 expanded
    expect(container.querySelector('.tool-card-body.expanded')).toBeInTheDocument()

    act(() => {
      rerender(<ToolCard toolCall={{ ...running, status: 'completed' }} />)
    })

    expect(container.querySelector('.tool-card-body.expanded')).not.toBeInTheDocument()
    // body 仍在 DOM
    expect(container.querySelector('.tool-card-body')).toBeInTheDocument()
  })

  it('completed → error：useEffect 触发后展开（加 expanded）', () => {
    const completed = makeToolCall({ status: 'completed' })
    const { container, rerender } = render(<ToolCard toolCall={completed} />)

    expect(container.querySelector('.tool-card-body.expanded')).not.toBeInTheDocument()

    act(() => {
      rerender(<ToolCard toolCall={{ ...completed, status: 'error' }} />)
    })

    expect(container.querySelector('.tool-card-body.expanded')).toBeInTheDocument()
  })
})

// ============================================================
// 4. .tool-status badge class 随状态正确切换
// ============================================================
describe('ToolCard — status badge class', () => {
  it('running 时 badge 包含 tool-status-running', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'running' })} />)
    expect(container.querySelector('.tool-status-running')).toBeInTheDocument()
  })

  it('completed 时 badge 包含 tool-status-completed', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'completed' })} />)
    expect(container.querySelector('.tool-status-completed')).toBeInTheDocument()
  })

  it('error 时 badge 包含 tool-status-error', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'error' })} />)
    expect(container.querySelector('.tool-status-error')).toBeInTheDocument()
  })
})
