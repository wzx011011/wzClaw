// @vitest-environment jsdom
// 测试 ToolCard 的 accordion 动画和状态指示器
// 覆盖以下变化：
//   1. .tool-status-dot icon-only 状态点（替代旧的 .tool-status-text badge）
//   2. .tool-card-verb 动词标签（替代旧的 .tool-card-name）
//   3. .tool-card-body 始终渲染（CSS 控制展开/折叠）
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
// 1. .tool-status-dot icon-only 状态点（新设计，对标手机端）
// ============================================================
describe('ToolCard — status dot (icon-only)', () => {
  it('completed 状态：.tool-status-dot 存在', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall()} />)
    expect(container.querySelector('.tool-status-dot')).toBeInTheDocument()
  })

  it('running 状态：.tool-status-dot 存在', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'running' })} />)
    expect(container.querySelector('.tool-status-dot')).toBeInTheDocument()
  })

  it('error 状态：.tool-status-dot 存在', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'error' })} />)
    expect(container.querySelector('.tool-status-dot')).toBeInTheDocument()
  })

  it('.tool-card-verb 内含动词（completed 默认 "Read"）', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall()} />)
    const verb = container.querySelector('.tool-card-verb')
    // Read completed → "Read"
    expect(verb?.textContent).toBe('Read')
  })

  it('running 时 .tool-card-verb 文字为 "Reading"', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'running' })} />)
    const verb = container.querySelector('.tool-card-verb')
    expect(verb?.textContent).toBe('Reading')
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
// 4. .tool-status-dot 随状态切换 class（icon-only 点）
// ============================================================
describe('ToolCard — status dot class', () => {
  it('running 时 dot 包含 tool-status-dot-running', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'running' })} />)
    expect(container.querySelector('.tool-status-dot-running')).toBeInTheDocument()
  })

  it('completed 时 dot 包含 tool-status-dot-completed', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'completed' })} />)
    expect(container.querySelector('.tool-status-dot-completed')).toBeInTheDocument()
  })

  it('error 时 dot 包含 tool-status-dot-error', () => {
    const { container } = render(<ToolCard toolCall={makeToolCall({ status: 'error' })} />)
    expect(container.querySelector('.tool-status-dot-error')).toBeInTheDocument()
  })
})
