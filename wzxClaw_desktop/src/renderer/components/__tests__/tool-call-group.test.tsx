// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'

// 隔离 ToolCard，只测 ToolCallGroup 自身逻辑
vi.mock('../chat/ToolCard', () => ({
  default: ({ toolCall }: { toolCall: { id: string; name: string } }) => (
    <div data-testid={`tc-${toolCall.id}`} className="mock-tool-card">
      {toolCall.name}
    </div>
  ),
}))

import ToolCallGroup from '../chat/ToolCallGroup'

// ============================================================
// 辅助：快速构造 ToolCallInfo
// ============================================================
let _seq = 0
function tc(
  overrides: Partial<{ id: string; name: string; status: 'running' | 'completed' | 'error' }> = {}
) {
  _seq++
  return {
    id: `id${_seq}`,
    name: 'Read',
    status: 'completed' as const,
    ...overrides,
  }
}

// ============================================================
// 1. 竖线 (rail) 阈值
// ============================================================
describe('ToolCallGroup — rail threshold', () => {
  it('1 个工具：有竖线（≥1 即显示，对标手机端）', () => {
    const { container } = render(<ToolCallGroup toolCalls={[tc()]} />)
    expect(container.querySelector('.tool-call-group-rail')).toBeInTheDocument()
  })

  it('2 个工具：有竖线', () => {
    const { container } = render(<ToolCallGroup toolCalls={[tc(), tc()]} />)
    expect(container.querySelector('.tool-call-group-rail')).toBeInTheDocument()
  })

  it('3 个工具：有竖线', () => {
    const { container } = render(<ToolCallGroup toolCalls={[tc(), tc(), tc()]} />)
    expect(container.querySelector('.tool-call-group-rail')).toBeInTheDocument()
  })
})

// ============================================================
// 2. WorkflowHeader 阈值
// ============================================================
describe('ToolCallGroup — header threshold', () => {
  it('1 个工具：无 header', () => {
    const { container } = render(<ToolCallGroup toolCalls={[tc()]} />)
    expect(container.querySelector('.tool-workflow-header')).not.toBeInTheDocument()
  })

  it('2 个工具：无 header', () => {
    const { container } = render(<ToolCallGroup toolCalls={[tc(), tc()]} />)
    expect(container.querySelector('.tool-workflow-header')).not.toBeInTheDocument()
  })

  it('3 个工具：有 header', () => {
    const { container } = render(<ToolCallGroup toolCalls={[tc(), tc(), tc()]} />)
    expect(container.querySelector('.tool-workflow-header')).toBeInTheDocument()
  })

  it('5 个工具：有 header', () => {
    const { container } = render(
      <ToolCallGroup toolCalls={[tc(), tc(), tc(), tc(), tc()]} />
    )
    expect(container.querySelector('.tool-workflow-header')).toBeInTheDocument()
  })
})

// ============================================================
// 3. WorkflowHeader 内容 — shimmer vs 摘要文字
// ============================================================
describe('ToolCallGroup — WorkflowHeader content', () => {
  it('有工具 running 时显示 shimmer "Working..."', () => {
    const tools = [
      tc({ name: 'Read', status: 'running' }),
      tc({ name: 'Bash', status: 'running' }),
      tc({ name: 'Read', status: 'completed' }),
    ]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const shimmer = container.querySelector('.tool-workflow-shimmer')
    expect(shimmer).toBeInTheDocument()
    expect(shimmer?.textContent).toMatch(/Working\.\.\.\s*\(\d+\/\d+\)/)
  })

  it('全部完成时不显示 shimmer，显示摘要文字', () => {
    const tools = [
      tc({ name: 'Read', status: 'completed' }),
      tc({ name: 'Read', status: 'completed' }),
      tc({ name: 'Bash', status: 'completed' }),
    ]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    expect(container.querySelector('.tool-workflow-shimmer')).not.toBeInTheDocument()
    const label = container.querySelector('.tool-workflow-label')
    expect(label?.textContent).toContain('Read')
  })

  it('Working 进度分子/分母正确', () => {
    const tools = [
      tc({ name: 'Read', status: 'completed' }),
      tc({ name: 'Bash', status: 'completed' }),
      tc({ name: 'Grep', status: 'running' }),
    ]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const shimmer = container.querySelector('.tool-workflow-shimmer')
    expect(shimmer?.textContent).toContain('2/3')
  })
})

// ============================================================
// 4. WorkflowHeader 状态图标
// ============================================================
describe('ToolCallGroup — WorkflowHeader status icon', () => {
  it('有 running 工具时显示 spinner', () => {
    const tools = [tc({ status: 'running' }), tc(), tc()]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    expect(container.querySelector('.tool-workflow-spinner')).toBeInTheDocument()
  })

  it('全部完成时显示 ✓', () => {
    const tools = [tc(), tc(), tc()]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const status = container.querySelector('.tool-workflow-status')
    expect(status?.textContent).toContain('✓')
  })

  it('有 error 时显示 ⚠', () => {
    const tools = [tc({ status: 'error' }), tc(), tc()]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const status = container.querySelector('.tool-workflow-status')
    expect(status?.textContent).toContain('⚠')
  })
})

// ============================================================
// 5. buildSummary 输出格式
// ============================================================
describe('ToolCallGroup — buildSummary', () => {
  it('单种工具 ×1：只显示名称', () => {
    const tools = [tc({ name: 'Read' }), tc({ name: 'Read' }), tc({ name: 'Read' })]
    // 两个 Read 应显示 Read(3) but wait — 这里3个 Read
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const label = container.querySelector('.tool-workflow-label')
    expect(label?.textContent).toContain('Read(3)')
  })

  it('多种工具：Read(2), Bash', () => {
    const tools = [
      tc({ name: 'Read' }),
      tc({ name: 'Read' }),
      tc({ name: 'Bash' }),
    ]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const label = container.querySelector('.tool-workflow-label')
    expect(label?.textContent).toMatch(/Read\(2\)/)
    expect(label?.textContent).toMatch(/Bash/)
  })

  it('单一工具只出现一次时不加括号', () => {
    const tools = [
      tc({ name: 'Read' }),
      tc({ name: 'Bash' }),
      tc({ name: 'Grep' }),
    ]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const label = container.querySelector('.tool-workflow-label')
    // 无括号
    expect(label?.textContent).not.toMatch(/Read\(\d+\)/)
    expect(label?.textContent).toContain('Read')
  })
})

// ============================================================
// 6. Toggle — 点击折叠/展开
// ============================================================
describe('ToolCallGroup — toggle collapse/expand', () => {
  it('初始状态：工具列表可见', () => {
    const tools = [tc({ id: 'a' }), tc({ id: 'b' }), tc({ id: 'c' })]
    render(<ToolCallGroup toolCalls={tools} />)
    expect(screen.getByTestId('tc-a')).toBeInTheDocument()
  })

  it('点击 header 后工具列表隐藏', () => {
    const tools = [tc({ id: 'a' }), tc({ id: 'b' }), tc({ id: 'c' })]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const header = container.querySelector('.tool-workflow-header')!
    fireEvent.click(header)
    expect(screen.queryByTestId('tc-a')).not.toBeInTheDocument()
  })

  it('再次点击 header 后工具列表重新显示', () => {
    const tools = [tc({ id: 'a' }), tc({ id: 'b' }), tc({ id: 'c' })]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const header = container.querySelector('.tool-workflow-header')!
    fireEvent.click(header)
    fireEvent.click(header)
    expect(screen.getByTestId('tc-a')).toBeInTheDocument()
  })

  it('折叠时箭头显示 ▶，展开时显示 ▼', () => {
    const tools = [tc(), tc(), tc()]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const toggle = container.querySelector('.tool-workflow-toggle')!
    expect(toggle.textContent).toBe('▼')
    fireEvent.click(container.querySelector('.tool-workflow-header')!)
    expect(toggle.textContent).toBe('▶')
  })
})

// ============================================================
// 7. 键盘无障碍 — Enter / Space 触发 toggle
// ============================================================
describe('ToolCallGroup — keyboard accessibility', () => {
  it('Enter 键折叠工具列表', () => {
    const tools = [tc({ id: 'k1' }), tc({ id: 'k2' }), tc({ id: 'k3' })]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const header = container.querySelector('.tool-workflow-header')!
    fireEvent.keyDown(header, { key: 'Enter' })
    expect(screen.queryByTestId('tc-k1')).not.toBeInTheDocument()
  })

  it('Space 键折叠工具列表', () => {
    const tools = [tc({ id: 's1' }), tc({ id: 's2' }), tc({ id: 's3' })]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const header = container.querySelector('.tool-workflow-header')!
    fireEvent.keyDown(header, { key: ' ' })
    expect(screen.queryByTestId('tc-s1')).not.toBeInTheDocument()
  })

  it('header 具有 role=button 和 tabIndex=0', () => {
    const tools = [tc(), tc(), tc()]
    const { container } = render(<ToolCallGroup toolCalls={tools} />)
    const header = container.querySelector('.tool-workflow-header')!
    expect(header.getAttribute('role')).toBe('button')
    expect(header.getAttribute('tabindex')).toBe('0')
  })
})

// ============================================================
// 8. 自动折叠/展开 — useEffect 驱动
// ============================================================
describe('ToolCallGroup — auto collapse/expand', () => {
  it('全部工具从 running → completed 时自动折叠（showHeader=true）', () => {
    const runningTools = [
      tc({ id: 'r1', status: 'running' }),
      tc({ id: 'r2', status: 'running' }),
      tc({ id: 'r3', status: 'running' }),
    ]
    const { rerender, container } = render(<ToolCallGroup toolCalls={runningTools} />)

    // 确认初始展开
    expect(screen.getByTestId('tc-r1')).toBeInTheDocument()

    // 全部完成
    act(() => {
      rerender(
        <ToolCallGroup
          toolCalls={[
            { ...runningTools[0], status: 'completed' },
            { ...runningTools[1], status: 'completed' },
            { ...runningTools[2], status: 'completed' },
          ]}
        />
      )
    })

    // 应自动折叠
    expect(screen.queryByTestId('tc-r1')).not.toBeInTheDocument()
    const toggle = container.querySelector('.tool-workflow-toggle')
    expect(toggle?.textContent).toBe('▶')
  })

  it('手动折叠后新工具开始 running → 自动展开', () => {
    const doneTools = [tc({ id: 'v1' }), tc({ id: 'v2' }), tc({ id: 'v3' })]
    const { container, rerender } = render(<ToolCallGroup toolCalls={doneTools} />)

    // 手动折叠
    const header = container.querySelector('.tool-workflow-header')!
    fireEvent.click(header)
    expect(container.querySelector('.tool-call-group-rail')).not.toBeInTheDocument()

    // 注入 running 工具 → auto-expand
    act(() => {
      rerender(
        <ToolCallGroup
          toolCalls={[
            { ...doneTools[0], status: 'running' },
            doneTools[1],
            doneTools[2],
          ]}
        />
      )
    })

    // 工具列表重新可见
    expect(container.querySelector('.tool-call-group-rail')).toBeInTheDocument()
    expect(container.querySelector('[data-testid="tc-v1"]')).toBeInTheDocument()
  })
})
