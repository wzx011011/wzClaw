import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useNotificationStore } from '../notification-store'

describe('NotificationStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useNotificationStore.setState({ notifications: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('add creates notification with correct type, message, timestamp', () => {
    const before = Date.now()
    const { add } = useNotificationStore.getState()
    add('info', 'Hello world')

    const state = useNotificationStore.getState()
    expect(state.notifications).toHaveLength(1)

    const notif = state.notifications[0]
    expect(notif.type).toBe('info')
    expect(notif.message).toBe('Hello world')
    expect(notif.timestamp).toBeGreaterThanOrEqual(before)
    expect(notif.id).toMatch(/^notif-\d+$/)
  })

  it('add with default duration (4000ms) sets up auto-dismiss', () => {
    const { add } = useNotificationStore.getState()
    add('success', 'Will auto-dismiss')

    expect(useNotificationStore.getState().notifications).toHaveLength(1)

    // Advance just before duration — should still be present
    vi.advanceTimersByTime(3999)
    expect(useNotificationStore.getState().notifications).toHaveLength(1)

    // Advance past duration — should be dismissed
    vi.advanceTimersByTime(1)
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('add with duration=0 does NOT auto-dismiss', () => {
    const { add } = useNotificationStore.getState()
    add('error', 'Persistent', 0)

    expect(useNotificationStore.getState().notifications).toHaveLength(1)

    // Advance well past default duration
    vi.advanceTimersByTime(10000)
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
  })

  it('dismiss removes specific notification', () => {
    const { add, dismiss } = useNotificationStore.getState()
    add('warning', 'First')
    add('error', 'Second')

    expect(useNotificationStore.getState().notifications).toHaveLength(2)

    const firstId = useNotificationStore.getState().notifications[0].id
    dismiss(firstId)

    const state = useNotificationStore.getState()
    expect(state.notifications).toHaveLength(1)
    expect(state.notifications[0].message).toBe('Second')
  })

  it('dismiss with unknown id is no-op', () => {
    const { add, dismiss } = useNotificationStore.getState()
    add('info', 'Real notification')

    dismiss('notif-nonexistent')

    expect(useNotificationStore.getState().notifications).toHaveLength(1)
  })

  it('clear removes all notifications', () => {
    const { add, clear } = useNotificationStore.getState()
    add('info', 'One')
    add('success', 'Two')
    add('error', 'Three')

    expect(useNotificationStore.getState().notifications).toHaveLength(3)

    clear()

    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('auto-dismiss fires after duration and removes correct notification', () => {
    const { add } = useNotificationStore.getState()
    add('info', 'Short-lived', 1000)
    add('error', 'Long-lived', 5000)

    // After 1000ms, first should be gone, second remains
    vi.advanceTimersByTime(1000)
    const state1 = useNotificationStore.getState()
    expect(state1.notifications).toHaveLength(1)
    expect(state1.notifications[0].message).toBe('Long-lived')

    // After another 4000ms (5000 total), second should be gone
    vi.advanceTimersByTime(4000)
    expect(useNotificationStore.getState().notifications).toHaveLength(0)
  })

  it('add generates incrementing IDs', () => {
    const { add } = useNotificationStore.getState()
    add('info', 'First')
    add('success', 'Second')
    add('warning', 'Third')

    const state = useNotificationStore.getState()
    // IDs are notif-N with incrementing N — just verify they are unique and ordered
    const ids = state.notifications.map((n) => n.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(3)

    // Extract numeric parts and verify ordering
    const nums = ids.map((id) => parseInt(id.replace('notif-', ''), 10))
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1])
    }
  })
})
