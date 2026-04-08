import { useEffect, useRef } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'

// ============================================================
// SymbolService — Subscribes to symbol queries from main process
// and responds using Monaco's built-in TypeScript worker.
// Mounted as a hidden component inside EditorPanel.
// ============================================================

interface SymbolResult {
  filePath: string
  line: number
  symbolName: string
  kind: string
}

interface SymbolServiceProps {
  editorRef: React.RefObject<MonacoEditor.IStandaloneCodeEditor | null>
}

export default function SymbolService({ editorRef }: SymbolServiceProps): JSX.Element {
  const unsubscribeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!window.wzxclaw?.onSymbolQuery) return

    const unsubscribe = window.wzxclaw.onSymbolQuery(async (payload) => {
      const { queryId, operation, params } = payload

      try {
        const editor = editorRef.current
        if (!editor) {
          window.wzxclaw.sendSymbolResult({ queryId, result: [], isError: true })
          return
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const monacoInstance = (window as any).monaco
        if (!monacoInstance) {
          window.wzxclaw.sendSymbolResult({ queryId, result: [], isError: true })
          return
        }

        let results: SymbolResult[] = []

        switch (operation) {
          case 'goto-definition': {
            results = await handleGoToDefinition(monacoInstance, params)
            break
          }
          case 'find-references': {
            results = await handleFindReferences(monacoInstance, params)
            break
          }
          case 'search-symbols': {
            results = handleSearchSymbols(monacoInstance, params)
            break
          }
          default: {
            results = []
          }
        }

        window.wzxclaw.sendSymbolResult({ queryId, result: results, isError: false })
      } catch (err) {
        console.error('SymbolService error:', err)
        window.wzxclaw.sendSymbolResult({
          queryId,
          result: [],
          isError: true
        })
      }
    })

    unsubscribeRef.current = unsubscribe

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
        unsubscribeRef.current = null
      }
    }
  }, [editorRef])

  return <></>
}

// ============================================================
// Symbol Operation Handlers
// ============================================================

async function handleGoToDefinition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monacoInstance: any,
  params: Record<string, unknown>
): Promise<SymbolResult[]> {
  const { symbolName, filePath } = params as { symbolName: string; filePath?: string }

  // Try to get TypeScript worker for the file
  const model = findModel(monacoInstance, filePath ?? '')
  if (!model) {
    // Fallback: search all models for the symbol name
    return searchAllModelsForSymbol(monacoInstance, symbolName, 'definition')
  }

  try {
    const worker = await monacoInstance.languages.typescript.getTypeScriptWorker()
    const client = await worker(model.uri)
    const position = findSymbolPosition(model, symbolName)
    if (!position) return []

    const defs = await client.getDefinitionAtPosition(
      model.uri.toString(),
      position.lineNumber,
      position.column
    )

    if (!defs || !Array.isArray(defs)) return []

    return defs.map((def: { fileName?: string; textSpan?: { start?: number }; kind?: string }) => {
      const defModel = def.fileName
        ? monacoInstance.editor.getModel(monacoInstance.Uri.parse(def.fileName))
        : null
      const defPos = defModel && def.textSpan?.start !== undefined
        ? defModel.getPositionAt(def.textSpan.start)
        : null

      return {
        filePath: def.fileName ?? '',
        line: defPos?.lineNumber ?? 0,
        symbolName,
        kind: mapScriptElementKind(def.kind)
      }
    })
  } catch {
    return searchAllModelsForSymbol(monacoInstance, symbolName, 'definition')
  }
}

async function handleFindReferences(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monacoInstance: any,
  params: Record<string, unknown>
): Promise<SymbolResult[]> {
  const { symbolName, filePath } = params as { symbolName: string; filePath?: string }

  const model = findModel(monacoInstance, filePath ?? '')
  if (!model) {
    return searchAllModelsForSymbol(monacoInstance, symbolName, 'reference')
  }

  try {
    const worker = await monacoInstance.languages.typescript.getTypeScriptWorker()
    const client = await worker(model.uri)
    const position = findSymbolPosition(model, symbolName)
    if (!position) return []

    const refs = await client.getReferencesAtPosition(
      model.uri.toString(),
      position.lineNumber,
      position.column
    )

    if (!refs || !Array.isArray(refs)) return []

    return refs.map((ref: { fileName?: string; textSpan?: { start?: number }; kind?: string }) => {
      const refModel = ref.fileName
        ? monacoInstance.editor.getModel(monacoInstance.Uri.parse(ref.fileName))
        : null
      const refPos = refModel && ref.textSpan?.start !== undefined
        ? refModel.getPositionAt(ref.textSpan.start)
        : null

      return {
        filePath: ref.fileName ?? '',
        line: refPos?.lineNumber ?? 0,
        symbolName,
        kind: mapScriptElementKind(ref.kind)
      }
    })
  } catch {
    return searchAllModelsForSymbol(monacoInstance, symbolName, 'reference')
  }
}

function handleSearchSymbols(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monacoInstance: any,
  params: Record<string, unknown>
): SymbolResult[] {
  const { query, maxResults } = params as { query: string; maxResults?: number }
  const limit = maxResults ?? 10
  const results: SymbolResult[] = []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

  const models = monacoInstance.editor.getModels()
  for (const model of models) {
    if (results.length >= limit) break

    const content = model.getValue()
    const lines = content.split('\n')
    const filePath = model.uri.toString()

    for (let i = 0; i < lines.length && results.length < limit; i++) {
      // Match identifier-like patterns
      const identifierPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g
      let match
      while ((match = identifierPattern.exec(lines[i])) !== null && results.length < limit) {
        if (pattern.test(match[1])) {
          results.push({
            filePath,
            line: i + 1,
            symbolName: match[1],
            kind: guessSymbolKind(lines[i], match.index)
          })
        }
      }
    }
  }

  return results
}

// ============================================================
// Helpers
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findModel(monacoInstance: any, filePath: string) {
  if (!filePath) return null
  const models = monacoInstance.editor.getModels()
  return models.find((m: { uri: { toString: () => string } }) =>
    m.uri.toString().includes(filePath) || m.uri.toString().endsWith(filePath)
  ) ?? null
}

function findSymbolPosition(
  model: { getValue: () => string; getPositionAt: (offset: number) => { lineNumber: number; column: number } },
  symbolName: string
): { lineNumber: number; column: number } | null {
  const content = model.getValue()
  const index = content.indexOf(symbolName)
  if (index === -1) return null
  return model.getPositionAt(index)
}

function searchAllModelsForSymbol(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monacoInstance: any,
  symbolName: string,
  type: 'definition' | 'reference'
): SymbolResult[] {
  const results: SymbolResult[] = []
  const models = monacoInstance.editor.getModels()

  for (const model of models) {
    const content = model.getValue()
    const lines = content.split('\n')
    const filePath = model.uri.toString()

    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].indexOf(symbolName)
      if (idx !== -1) {
        results.push({
          filePath,
          line: i + 1,
          symbolName,
          kind: type === 'definition' ? guessSymbolKind(lines[i], idx) : 'reference'
        })
        if (results.length >= 20) break
      }
    }
    if (results.length >= 20) break
  }

  return results
}

function guessSymbolKind(line: string, col: number): string {
  const before = line.substring(0, col).trim()
  if (/\bfunction\b/.test(before) || /\b=>\s*$/.test(before)) return 'function'
  if (/\bclass\b/.test(before)) return 'class'
  if (/\binterface\b/.test(before)) return 'interface'
  if (/\btype\b/.test(before)) return 'type'
  if (/\bconst\b/.test(before) || /\blet\b/.test(before) || /\bvar\b/.test(before)) return 'variable'
  if (/\bimport\b/.test(before)) return 'import'
  return 'unknown'
}

function mapScriptElementKind(kind?: string): string {
  if (!kind) return 'unknown'
  const lower = kind.toLowerCase()
  if (lower.includes('function') || lower.includes('method')) return 'function'
  if (lower.includes('class')) return 'class'
  if (lower.includes('interface')) return 'interface'
  if (lower.includes('variable') || lower.includes('property')) return 'variable'
  if (lower.includes('module') || lower.includes('namespace')) return 'module'
  if (lower.includes('type')) return 'type'
  if (lower.includes('enum')) return 'enum'
  return 'unknown'
}
