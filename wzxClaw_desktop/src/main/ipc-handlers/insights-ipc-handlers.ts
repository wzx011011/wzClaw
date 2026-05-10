import { ipcMain } from 'electron'
import path from 'path'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { getAppDataDir, getInsightsCacheDir, getInsightsReportDir } from '../paths'
import { SettingsManager } from '../settings-manager'

export interface InsightsIpcDeps {
  settingsManager: SettingsManager
}

export function registerInsightsIpcHandlers(deps: InsightsIpcDeps): void {
  const { settingsManager } = deps

  // ============================================================
  // Insights: generate session analysis report
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['insights:generate'], async (event) => {
    const sender = event.sender
    const sendProgress = (stage: string, current: number, total: number, message: string) => {
      sender.send(IPC_CHANNELS['insights:progress'], { stage, current, total, message })
    }

    const config = settingsManager.getCurrentConfig()
    if (!config.apiKey) {
      throw new Error('No API key configured. Set an API key in Settings to use /insights.')
    }

    // Insights uses OpenAI-compatible /chat/completions endpoint.
    // If provider is anthropic with an Anthropic-specific baseURL (e.g. bigmodel.cn/api/anthropic),
    // convert to the OpenAI-compatible endpoint so raw fetch() works.
    let effectiveBaseUrl = config.baseURL || 'https://open.bigmodel.cn/api/paas/v4'
    if (config.provider === 'anthropic') {
      if (effectiveBaseUrl.includes('/anthropic')) {
        effectiveBaseUrl = effectiveBaseUrl.replace(/\/anthropic.*/, '/paas/v4')
      } else if (effectiveBaseUrl.includes('anthropic.com')) {
        // Real Anthropic — cannot use OpenAI format, fall back to env var or error
        const openaiKey = process.env.OPENAI_API_KEY
        if (openaiKey) {
          effectiveBaseUrl = 'https://api.openai.com/v1'
          console.log(`[insights] Anthropic provider detected, falling back to OPENAI_API_KEY for insights`)
        } else {
          throw new Error('Insights requires an OpenAI-compatible API endpoint. Configure an OpenAI API key or use a provider with OpenAI-compatible endpoint.')
        }
      }
    }
    console.log(`[insights] config: provider=${config.provider} model=${config.model} baseURL=${effectiveBaseUrl} hasApiKey=${!!config.apiKey}`)

    // Dynamic import to avoid loading insights modules at startup
    const { scanAllSessions, loadSessionMessages } = await import('../insights/session-scanner')
    const { batchExtractFacets } = await import('../insights/facet-extractor')
    const { aggregateData, generateInsights, buildInsightReport } = await import('../insights/insight-generator')

    const sessionsRoot = path.join(getAppDataDir(), 'sessions')
    const cacheDir = getInsightsCacheDir()
    const reportDir = getInsightsReportDir()

    // Stage 1: Scan sessions
    sendProgress('scanning', 0, 0, 'Scanning session files...')
    const allMeta = await scanAllSessions(sessionsRoot)

    if (allMeta.length === 0) {
      throw new Error('No sessions found. Start coding first, then run /insights.')
    }

    // Stage 2: Extract facets
    sendProgress('extracting_facets', 0, allMeta.length, `Analyzing ${allMeta.length} sessions...`)
    const sessionsWithData = []
    for (const meta of allMeta) {
      const messages = await loadSessionMessages(
        path.join(sessionsRoot, meta.projectHash, `${meta.sessionId}.jsonl`),
      )
      sessionsWithData.push({ meta, messages })
    }

    const facets = await batchExtractFacets(
      sessionsWithData,
      config.apiKey,
      effectiveBaseUrl,
      config.model,
      cacheDir,
      (current, total) => sendProgress('extracting_facets', current, total, `Analyzing session ${current}/${total}...`),
    )

    // Stage 3: Aggregate
    sendProgress('aggregating', 0, 0, 'Aggregating statistics...')
    const aggregated = aggregateData(allMeta, facets)

    // Stage 4: Generate insights
    sendProgress('generating_insights', 0, 6, 'Generating insights...')
    const sections = await generateInsights(
      aggregated,
      config.apiKey,
      effectiveBaseUrl,
      config.model,
      (sectionId) => sendProgress('generating_insights', 0, 6, `Generating: ${sectionId}...`),
    )

    // Stage 5: Build report
    sendProgress('rendering', 0, 0, 'Rendering report...')
    const result = await buildInsightReport(aggregated, sections, reportDir)

    sendProgress('done', 0, 0, 'Done!')
    return result
  })
}
