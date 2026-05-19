import { describe, it, expect } from 'vitest'
import { PermissionManager } from '../permission-manager.js'

describe('PermissionManager', () => {
  describe('bypass mode', () => {
    const pm = new PermissionManager('bypass')

    it('auto-approves all tools', () => {
      expect(pm.needsApproval('Bash')).toBe(false)
      expect(pm.needsApproval('FileWrite')).toBe(false)
      expect(pm.needsApproval('FileRead')).toBe(false)
    })

    it('requestApproval returns true without handler', async () => {
      expect(await pm.requestApproval('s1', 'Bash', { command: 'rm -rf /' })).toBe(true)
    })
  })

  describe('accept-edits mode', () => {
    const pm = new PermissionManager('accept-edits')

    it('auto-approves read-only tools', () => {
      expect(pm.needsApproval('FileRead')).toBe(false)
      expect(pm.needsApproval('Grep')).toBe(false)
      expect(pm.needsApproval('Glob')).toBe(false)
    })

    it('auto-approves file tools', () => {
      expect(pm.needsApproval('FileWrite')).toBe(false)
      expect(pm.needsApproval('FileEdit')).toBe(false)
    })

    it('requires approval for Bash', () => {
      expect(pm.needsApproval('Bash')).toBe(true)
    })
  })

  describe('plan mode', () => {
    const pm = new PermissionManager('plan')

    it('auto-approves read-only tools', () => {
      expect(pm.needsApproval('FileRead')).toBe(false)
      expect(pm.needsApproval('Grep')).toBe(false)
    })

    it('rejects write tools', () => {
      expect(pm.needsApproval('FileWrite')).toBe(true)
      expect(pm.needsApproval('Bash')).toBe(true)
    })

    it('getPlanModeRejection returns message for write tools', () => {
      expect(pm.getPlanModeRejection('FileWrite')).toContain('不允许执行写操作')
    })

    it('getPlanModeRejection returns null for read tools', () => {
      expect(pm.getPlanModeRejection('FileRead')).toBeNull()
    })
  })

  describe('always-ask mode', () => {
    it('requires approval for all tools', () => {
      const pm = new PermissionManager('always-ask')
      expect(pm.needsApproval('FileRead')).toBe(true)
      expect(pm.needsApproval('Bash')).toBe(true)
    })

    it('calls approval handler when set', async () => {
      const pm = new PermissionManager('always-ask', async () => false)
      expect(await pm.requestApproval('s1', 'FileRead', {})).toBe(false)
    })

    it('returns true when no handler', async () => {
      const pm = new PermissionManager('always-ask')
      expect(await pm.requestApproval('s1', 'FileRead', {})).toBe(true)
    })
  })

  describe('mode management', () => {
    it('setMode changes mode', () => {
      const pm = new PermissionManager('bypass')
      pm.setMode('plan')
      expect(pm.getMode()).toBe('plan')
    })

    it('setMode ignores invalid modes', () => {
      const pm = new PermissionManager('bypass')
      pm.setMode('invalid')
      expect(pm.getMode()).toBe('bypass')
    })

    it('cycleMode cycles through modes', () => {
      const pm = new PermissionManager('bypass')
      expect(pm.cycleMode()).toBe('always-ask')
      expect(pm.cycleMode()).toBe('accept-edits')
      expect(pm.cycleMode()).toBe('plan')
      expect(pm.cycleMode()).toBe('bypass')
    })
  })

  describe('always-allow rules', () => {
    it('auto-approves tools in rules', () => {
      const pm = new PermissionManager('always-ask')
      pm.loadAlwaysAllowRules(['FileRead', 'Bash:git status'])
      expect(pm.needsApproval('FileRead')).toBe(false)
      expect(pm.needsApproval('Bash', { command: 'git status' })).toBe(false)
      expect(pm.needsApproval('Bash', { command: 'rm -rf /' })).toBe(true)
    })
  })

  describe('plan mode overlay', () => {
    it('planModeActive overrides base mode for write tools', () => {
      const pm = new PermissionManager('accept-edits')
      pm.setPlanMode(true)
      expect(pm.needsApproval('FileWrite')).toBe(true)
      expect(pm.needsApproval('FileRead')).toBe(false)
      pm.setPlanMode(false)
      expect(pm.needsApproval('FileWrite')).toBe(false)
    })
  })

  describe('command prefix extraction', () => {
    const pm = new PermissionManager('always-ask')
    pm.loadAlwaysAllowRules(['Bash:git status'])

    it('matches simple command', () => {
      expect(pm.needsApproval('Bash', { command: 'git status' })).toBe(false)
    })

    it('matches command with env prefix', () => {
      expect(pm.needsApproval('Bash', { command: 'NODE_ENV=test git status' })).toBe(false)
    })

    it('matches command with sudo prefix', () => {
      expect(pm.needsApproval('Bash', { command: 'sudo git status' })).toBe(false)
    })

    it('does not match different command', () => {
      expect(pm.needsApproval('Bash', { command: 'git commit' })).toBe(true)
    })
  })
})
