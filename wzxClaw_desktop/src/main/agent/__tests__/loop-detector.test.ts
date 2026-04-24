import { describe, it, expect } from 'vitest'
import { LoopDetector } from '../loop-detector'

describe('LoopDetector', () => {
  it('detects 3 consecutive identical tool calls as a loop', () => {
    const detector = new LoopDetector()
    const input = { path: '/foo/bar.ts' }

    detector.record('file_read', input)
    detector.record('file_read', input)
    detector.record('file_read', input)

    expect(detector.isLooping()).toBe(true)
  })

  it('does not detect a loop with only 2 identical calls', () => {
    const detector = new LoopDetector()
    const input = { path: '/foo/bar.ts' }

    detector.record('file_read', input)
    detector.record('file_read', input)

    expect(detector.isLooping()).toBe(false)
  })

  it('does not detect a loop when identical calls are not consecutive', () => {
    const detector = new LoopDetector()
    const inputA = { path: '/foo/bar.ts' }
    const inputB = { path: '/baz/qux.ts' }

    detector.record('file_read', inputA)
    detector.record('file_read', inputA)
    detector.record('file_read', inputB) // breaks the streak
    detector.record('file_read', inputA)

    expect(detector.isLooping()).toBe(false)
  })

  it('returns false for empty history', () => {
    const detector = new LoopDetector()
    expect(detector.isLooping()).toBe(false)
  })

  it('clears history on reset', () => {
    const detector = new LoopDetector()
    const input = { path: '/foo/bar.ts' }

    detector.record('file_read', input)
    detector.record('file_read', input)
    detector.record('file_read', input)

    expect(detector.isLooping()).toBe(true)

    detector.reset()
    expect(detector.isLooping()).toBe(false)
  })

  it('serializes input deterministically via JSON.stringify', () => {
    const detector = new LoopDetector()

    // Same logical content, different key order
    const input1 = { a: 1, b: 2 }
    const input2 = { b: 2, a: 1 }

    detector.record('tool', input1)
    detector.record('tool', input2)
    detector.record('tool', input1)

    // JSON.stringify on {a:1,b:2} and {b:2,a:1} may produce different strings
    // depending on insertion order, so they should NOT be treated as identical
    // unless the serialization is the same. We test that they produce consistent
    // results with the same object reference.
    const detector2 = new LoopDetector()
    const input3 = { a: 1, b: 2 }

    detector2.record('tool', input3)
    detector2.record('tool', input3)
    detector2.record('tool', input3)

    expect(detector2.isLooping()).toBe(true)
  })

  it('getLastCall returns the most recent call', () => {
    const detector = new LoopDetector()
    const input = { path: '/foo.ts' }

    detector.record('file_read', input)

    const last = detector.getLastCall()
    expect(last).toEqual({ name: 'file_read', inputKey: JSON.stringify(input) })
  })

  it('getLastCall returns undefined when history is empty', () => {
    const detector = new LoopDetector()
    expect(detector.getLastCall()).toBeUndefined()
  })

  it('detects loops with different tool names but same input as NOT a loop', () => {
    const detector = new LoopDetector()
    const input = { pattern: 'TODO' }

    detector.record('grep', input)
    detector.record('glob', input) // different tool name
    detector.record('grep', input)

    expect(detector.isLooping()).toBe(false)
  })
})
