import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCommandStore } from '../command-store'

describe('CommandStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useCommandStore.setState({
      commands: [],
      paletteOpen: false
    })
  })

  describe('register', () => {
    it('should add a command to the commands array', () => {
      const { register } = useCommandStore.getState()
      register({
        id: 'test.cmd',
        label: 'Test Command',
        category: 'Test',
        handler: vi.fn()
      })
      expect(useCommandStore.getState().commands).toHaveLength(1)
      expect(useCommandStore.getState().commands[0].id).toBe('test.cmd')
    })

    it('should replace existing command when re-registering with the same id', () => {
      const { register } = useCommandStore.getState()
      register({
        id: 'test.cmd',
        label: 'First Label',
        category: 'Test',
        handler: vi.fn()
      })
      register({
        id: 'test.cmd',
        label: 'Updated Label',
        category: 'Test',
        handler: vi.fn()
      })
      expect(useCommandStore.getState().commands).toHaveLength(1)
      expect(useCommandStore.getState().commands[0].label).toBe('Updated Label')
    })
  })

  describe('unregister', () => {
    it('should remove a command by id', () => {
      const { register, unregister } = useCommandStore.getState()
      register({
        id: 'test.cmd',
        label: 'Test Command',
        category: 'Test',
        handler: vi.fn()
      })
      expect(useCommandStore.getState().commands).toHaveLength(1)
      unregister('test.cmd')
      expect(useCommandStore.getState().commands).toHaveLength(0)
    })
  })

  describe('execute', () => {
    it('should call the handler function when executing a valid id', () => {
      const handler = vi.fn()
      const { register, execute } = useCommandStore.getState()
      register({
        id: 'test.cmd',
        label: 'Test Command',
        category: 'Test',
        handler
      })
      execute('test.cmd')
      expect(handler).toHaveBeenCalledOnce()
    })

    it('should do nothing when executing an invalid id', () => {
      const { execute } = useCommandStore.getState()
      expect(() => execute('nonexistent')).not.toThrow()
    })

    it('should skip commands with available: false', () => {
      const handler = vi.fn()
      const { register, execute } = useCommandStore.getState()
      register({
        id: 'test.unavailable',
        label: 'Unavailable',
        category: 'Test',
        handler,
        available: false
      })
      execute('test.unavailable')
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('built-in commands', () => {
    it('should register 8 built-in commands with correct labels and categories', () => {
      const { registerBuiltInCommands } = useCommandStore.getState()
      registerBuiltInCommands({
        openFolder: vi.fn(),
        clearConversation: vi.fn(),
        saveActiveTab: vi.fn(),
        updateSettings: vi.fn(),
        openSettingsModal: vi.fn()
      })
      const { commands } = useCommandStore.getState()
      expect(commands).toHaveLength(8)

      const labels = commands.map((c) => c.label)
      expect(labels).toContain('Open Folder')
      expect(labels).toContain('Save File')
      expect(labels).toContain('New Session')
      expect(labels).toContain('Clear Session')
      expect(labels).toContain('Toggle Sidebar')
      expect(labels).toContain('Toggle Terminal')
      expect(labels).toContain('Change Model')
      expect(labels).toContain('Open Settings')
    })

    it('should have correct shortcuts for Open Folder, Save File, Toggle Sidebar, and Toggle Terminal', () => {
      const { registerBuiltInCommands } = useCommandStore.getState()
      registerBuiltInCommands({
        openFolder: vi.fn(),
        clearConversation: vi.fn(),
        saveActiveTab: vi.fn(),
        updateSettings: vi.fn(),
        openSettingsModal: vi.fn()
      })
      const { commands } = useCommandStore.getState()

      const openFolder = commands.find((c) => c.id === 'file.open-folder')
      expect(openFolder?.shortcut).toBe('Ctrl+Shift+O')

      const saveFile = commands.find((c) => c.id === 'file.save')
      expect(saveFile?.shortcut).toBe('Ctrl+S')

      const toggleSidebar = commands.find((c) => c.id === 'view.toggle-sidebar')
      expect(toggleSidebar?.shortcut).toBe('Ctrl+B')

      const toggleTerminal = commands.find((c) => c.id === 'view.toggle-terminal')
      expect(toggleTerminal?.shortcut).toBe('Ctrl+`')
    })
  })

  describe('plugin system', () => {
    it('should allow external code to register a new command', () => {
      const { register } = useCommandStore.getState()
      register({
        id: 'plugin.custom',
        label: 'Custom Plugin Command',
        category: 'Plugin',
        handler: vi.fn()
      })
      const { commands } = useCommandStore.getState()
      expect(commands).toHaveLength(1)
      expect(commands[0].id).toBe('plugin.custom')
    })

    it('should allow external code to unregister a command', () => {
      const { register, unregister } = useCommandStore.getState()
      register({
        id: 'plugin.custom',
        label: 'Custom Plugin Command',
        category: 'Plugin',
        handler: vi.fn()
      })
      expect(useCommandStore.getState().commands).toHaveLength(1)
      unregister('plugin.custom')
      expect(useCommandStore.getState().commands).toHaveLength(0)
    })
  })

  describe('palette state', () => {
    it('should set paletteOpen to true when openPalette is called', () => {
      const { openPalette } = useCommandStore.getState()
      expect(useCommandStore.getState().paletteOpen).toBe(false)
      openPalette()
      expect(useCommandStore.getState().paletteOpen).toBe(true)
    })

    it('should set paletteOpen to false when closePalette is called', () => {
      const { openPalette, closePalette } = useCommandStore.getState()
      openPalette()
      expect(useCommandStore.getState().paletteOpen).toBe(true)
      closePalette()
      expect(useCommandStore.getState().paletteOpen).toBe(false)
    })
  })

  describe('unavailable commands', () => {
    it('should have available: false flag on toggle-terminal command', () => {
      const { registerBuiltInCommands } = useCommandStore.getState()
      registerBuiltInCommands({
        openFolder: vi.fn(),
        clearConversation: vi.fn(),
        saveActiveTab: vi.fn(),
        updateSettings: vi.fn(),
        openSettingsModal: vi.fn()
      })
      const toggleTerminal = useCommandStore.getState().commands.find(
        (c) => c.id === 'view.toggle-terminal'
      )
      expect(toggleTerminal?.available).toBe(false)
    })
  })
})
