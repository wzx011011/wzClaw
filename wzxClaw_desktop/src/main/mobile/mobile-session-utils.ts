import path from 'path'

export function getMobileSessionTransition(params: {
  requestedSessionId?: string | null
  activeSessionId?: string | null
  hasMessages: boolean
  generatedSessionId: string
}): {
  sessionId: string
  shouldResetContext: boolean
  shouldRestoreHistory: boolean
} {
  const requestedSessionId = params.requestedSessionId ?? null
  const activeSessionId = params.activeSessionId ?? null
  const sessionId = requestedSessionId || activeSessionId || params.generatedSessionId
  const switchingSessions = Boolean(requestedSessionId && activeSessionId && requestedSessionId !== activeSessionId)

  return {
    sessionId,
    shouldResetContext: switchingSessions && params.hasMessages,
    shouldRestoreHistory: Boolean(requestedSessionId) && (!params.hasMessages || switchingSessions),
  }
}

export function isPathWithinWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(workspaceRoot)
  const resolvedTarget = path.resolve(targetPath)
  const normalize = process.platform === 'win32'
    ? (value: string) => value.toLowerCase()
    : (value: string) => value
  const normalizedRoot = normalize(resolvedRoot)
  const normalizedTarget = normalize(resolvedTarget)

  if (normalizedTarget === normalizedRoot) {
    return true
  }

  const rootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`

  return normalizedTarget.startsWith(rootPrefix)
}