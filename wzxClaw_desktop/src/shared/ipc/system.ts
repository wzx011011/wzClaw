// System / misc IPC channels (diagnostics, shell, UI, todo, tools)
export const SYSTEM_CHANNELS = {
  // Doctor / diagnostics
  'system:doctor': 'system:doctor',
  // Shell integration
  'shell:open_path': 'shell:open_path',
  'shell:get_extension_paths': 'shell:get_extension_paths',
  // Titlebar theming
  'theme:set-titlebar-overlay': 'theme:set-titlebar-overlay',
  // Todo persistence
  'todo:load': 'todo:load',
  // Tool registry introspection
  'tools:list': 'tools:list',
} as const
