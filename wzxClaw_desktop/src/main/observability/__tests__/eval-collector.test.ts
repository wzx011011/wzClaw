import { describe, it, expect } from 'vitest'
import { EvalCollector } from '../eval-collector'

describe('EvalCollector', () => {
  it('computes avg_input_per_turn when inputTokens are recorded', () => {
    const collector = new EvalCollector()
    collector.recordTurn(100, 500)
    collector.recordTurn(200, 300)

    const scores = collector.computeScores()
    const avgInput = scores.find(s => s.name === 'avg_input_per_turn')
    expect(avgInput).toBeDefined()
    expect(avgInput!.value).toBe(400) // (500 + 300) / 2 = 400
  })

  it('computes avg_output_per_turn', () => {
    const collector = new EvalCollector()
    collector.recordTurn(100)
    collector.recordTurn(200)

    const scores = collector.computeScores()
    const avgOutput = scores.find(s => s.name === 'avg_output_per_turn')
    expect(avgOutput).toBeDefined()
    expect(avgOutput!.value).toBe(150) // (100 + 200) / 2
  })

  it('omits avg_input_per_turn when no inputTokens recorded', () => {
    const collector = new EvalCollector()
    collector.recordTurn(100) // no inputTokens

    const scores = collector.computeScores()
    const avgInput = scores.find(s => s.name === 'avg_input_per_turn')
    expect(avgInput).toBeUndefined()
  })

  it('accumulates totalInputTokens across multiple turns', () => {
    const collector = new EvalCollector()
    collector.recordTurn(50, 1000)
    collector.recordTurn(50, 2000)
    collector.recordTurn(50) // no input

    const scores = collector.computeScores()
    const avgInput = scores.find(s => s.name === 'avg_input_per_turn')
    expect(avgInput).toBeDefined()
    expect(avgInput!.value).toBe(1000) // (1000 + 2000) / 3 = 1000
  })

  it('handles recordTurn with optional inputTokens gracefully', () => {
    const collector = new EvalCollector()
    collector.recordTurn(100, undefined)
    collector.recordTurn(200, 600)

    const scores = collector.computeScores()
    const avgInput = scores.find(s => s.name === 'avg_input_per_turn')
    expect(avgInput).toBeDefined()
    expect(avgInput!.value).toBe(300) // 600 / 2
  })

  it('computes tool_success_rate correctly', () => {
    const collector = new EvalCollector()
    collector.recordToolCall('FileRead', false, false)
    collector.recordToolCall('Bash', true, false)
    collector.recordToolCall('FileRead', false, false)

    const scores = collector.computeScores()
    const rate = scores.find(s => s.name === 'tool_success_rate')
    expect(rate).toBeDefined()
    expect(rate!.value).toBeCloseTo(0.667, 2)
  })

  it('computes tool_diversity correctly', () => {
    const collector = new EvalCollector()
    collector.recordToolCall('FileRead', false, false)
    collector.recordToolCall('FileRead', false, false)
    collector.recordToolCall('Bash', false, false)

    const scores = collector.computeScores()
    const diversity = scores.find(s => s.name === 'tool_diversity')
    expect(diversity).toBeDefined()
    expect(diversity!.value).toBeCloseTo(0.667, 2) // 2 unique / 3 total
  })
})
