// ============================================================
// insight-generator.ts — Stage 3-5: 聚合 + 8 洞察 sections + Chart.js HTML 报告
// 对齐 Claude Code /insights 的完整输出
// ============================================================

import fsp from 'fs/promises'
import path from 'path'
import { shell } from 'electron'
import type { SessionInsightMeta, SessionFacets, AggregatedInsightData, InsightSection, InsightResult } from './insight-types'

// ============================================================
// Stage 3: Aggregation
// ============================================================

export function aggregateData(
  allMeta: SessionInsightMeta[],
  allFacets: (SessionFacets | null)[],
): AggregatedInsightData {
  let totalInput = 0
  let totalOutput = 0
  let totalCost = 0
  let totalErrors = 0
  let totalToolCalls = 0
  let totalLinesAdded = 0
  let totalLinesRemoved = 0
  let totalFilesModified = 0
  let totalGitCommits = 0
  let totalGitPushes = 0
  let totalInterruptions = 0
  let earliest = Infinity
  let latest = -Infinity

  const toolCounts: Record<string, number> = {}
  const modelSessions: Record<string, number> = {}
  const modelTokens: Record<string, { input: number; output: number }> = {}
  const languageCounts: Record<string, number> = {}
  const projectCounts: Record<string, number> = {}
  const toolErrorCategories: Record<string, number> = {}
  const allResponseTimes: number[] = []
  const allMessageHours: number[] = []
  let sessionsUsingTaskAgent = 0
  let sessionsUsingMcp = 0
  let sessionsUsingWebSearch = 0
  let sessionsUsingWebFetch = 0

  // Facet aggregations
  const sessionsByOutcome: Record<string, number> = {}
  const sessionsByType: Record<string, number> = {}
  const sessionsByHelpfulness: Record<string, number> = {}
  const sessionsBySatisfaction: Record<string, number> = {}
  const goalCategories: Record<string, number> = {}
  const friction: Record<string, number> = {}
  const success: Record<string, number> = {}
  const sessionSummaries: Array<{ id: string; date: string; summary: string; goal?: string }> = []
  let sessionsWithFacets = 0

  for (const meta of allMeta) {
    totalInput += meta.totalInputTokens
    totalOutput += meta.totalOutputTokens
    totalCost += meta.estimatedCostUSD
    totalErrors += meta.toolErrorCount
    totalToolCalls += meta.toolCallCount
    totalLinesAdded += meta.linesAdded
    totalLinesRemoved += meta.linesRemoved
    totalFilesModified += meta.filesModified
    totalGitCommits += meta.gitCommits
    totalGitPushes += meta.gitPushes
    totalInterruptions += meta.userInterruptions

    if (meta.createdAt < earliest) earliest = meta.createdAt
    if (meta.updatedAt > latest) latest = meta.updatedAt

    for (const [tool, count] of Object.entries(meta.toolCounts)) {
      toolCounts[tool] = (toolCounts[tool] || 0) + count
    }

    if (meta.model) {
      modelSessions[meta.model] = (modelSessions[meta.model] || 0) + 1
      if (!modelTokens[meta.model]) modelTokens[meta.model] = { input: 0, output: 0 }
      modelTokens[meta.model].input += meta.totalInputTokens
      modelTokens[meta.model].output += meta.totalOutputTokens
    }

    for (const lang of meta.languages) {
      languageCounts[lang] = (languageCounts[lang] || 0) + 1
    }

    projectCounts[meta.projectHash] = (projectCounts[meta.projectHash] || 0) + 1

    for (const [cat, count] of Object.entries(meta.toolErrorCategories)) {
      toolErrorCategories[cat] = (toolErrorCategories[cat] || 0) + count
    }

    allResponseTimes.push(...meta.userResponseTimes)
    allMessageHours.push(...meta.messageHours)

    if (meta.usesTaskAgent) sessionsUsingTaskAgent++
    if (meta.usesMcp) sessionsUsingMcp++
    if (meta.usesWebSearch) sessionsUsingWebSearch++
    if (meta.usesWebFetch) sessionsUsingWebFetch++
  }

  // Facet aggregations
  for (const facet of allFacets) {
    if (!facet) continue
    sessionsWithFacets++
    sessionsByOutcome[facet.outcome] = (sessionsByOutcome[facet.outcome] || 0) + 1
    sessionsByType[facet.sessionType] = (sessionsByType[facet.sessionType] || 0) + 1
    sessionsByHelpfulness[facet.claudeHelpfulness] = (sessionsByHelpfulness[facet.claudeHelpfulness] || 0) + 1
    for (const [level, count] of Object.entries(facet.userSatisfaction)) {
      sessionsBySatisfaction[level] = (sessionsBySatisfaction[level] || 0) + count
    }
    for (const [cat, count] of Object.entries(facet.goalCategories)) {
      goalCategories[cat] = (goalCategories[cat] || 0) + count
    }
    for (const [fType, count] of Object.entries(facet.frictionCounts)) {
      friction[fType] = (friction[fType] || 0) + count
    }
    if (facet.primarySuccess && facet.primarySuccess !== 'none') {
      success[facet.primarySuccess] = (success[facet.primarySuccess] || 0) + 1
    }
  }

  const n = allMeta.length || 1
  allResponseTimes.sort((a, b) => a - b)
  const medianRT = allResponseTimes.length > 0
    ? allResponseTimes[Math.floor(allResponseTimes.length / 2)]
    : 0
  const avgRT = allResponseTimes.length > 0
    ? allResponseTimes.reduce((s, t) => s + t, 0) / allResponseTimes.length
    : 0

  // Days active
  const dateSet = new Set<string>()
  for (const m of allMeta) {
    if (m.createdAt > 0) dateSet.add(new Date(m.createdAt).toISOString().slice(0, 10))
  }

  const sessionSummariesList: Array<{ id: string; date: string; summary: string; goal?: string }> = []
  for (let i = 0; i < allMeta.length; i++) {
    const facet = allFacets[i]
    if (!facet?.briefSummary) continue
    sessionSummariesList.push({
      id: allMeta[i].sessionId.slice(0, 8),
      date: new Date(allMeta[i].createdAt).toISOString().slice(0, 10),
      summary: facet.briefSummary,
      goal: facet.underlyingGoal,
    })
    if (sessionSummariesList.length >= 20) break
  }

  return {
    totalSessions: allMeta.length,
    sessionsWithFacets,
    dateRange: {
      earliest: earliest === Infinity ? 0 : earliest,
      latest: latest === -Infinity ? 0 : latest,
    },
    totalTokens: { input: totalInput, output: totalOutput },
    totalCostUSD: totalCost,
    totalDurationHours: allMeta.reduce((s, m) => s + m.durationMs, 0) / 3_600_000,
    totalMessages: allMeta.reduce((s, m) => s + m.userMessageCount + m.assistantMessageCount, 0),
    totalGitCommits,
    totalGitPushes,
    totalInterruptions,
    totalToolErrors: totalErrors,
    toolErrorCategories,
    medianResponseTime: medianRT,
    avgResponseTime: avgRT,
    sessionsByOutcome,
    sessionsByType,
    sessionsByHelpfulness,
    sessionsBySatisfaction,
    goalCategories,
    friction,
    success,
    topTools: topN(toolCounts, 10),
    topModels: Object.entries(modelSessions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([model, sessions]) => ({
        model,
        sessions,
        inputTokens: modelTokens[model]?.input || 0,
        outputTokens: modelTokens[model]?.output || 0,
      })),
    topLanguages: topN(languageCounts, 8),
    topProjects: projectCounts,
    avgTokensPerSession: Math.round((totalInput + totalOutput) / n),
    avgCostPerSession: totalCost / n,
    avgDurationMinutes: allMeta.reduce((s, m) => s + m.durationMs, 0) / n / 60_000,
    avgToolSuccessRate: totalToolCalls > 0 ? 1 - totalErrors / totalToolCalls : 1,
    totalLinesAdded,
    totalLinesRemoved,
    totalFilesModified,
    daysActive: dateSet.size,
    messagesPerDay: dateSet.size > 0 ? Math.round(allMeta.reduce((s, m) => s + m.userMessageCount, 0) / dateSet.size) : 0,
    messageHours: allMessageHours,
    sessionsUsingTaskAgent,
    sessionsUsingMcp,
    sessionsUsingWebSearch,
    sessionsUsingWebFetch,
    sessionSummaries: sessionSummariesList,
    multiClauding: { overlapEvents: 0, sessionsInvolved: 0, userMessagesDuring: 0 },
  }
}

// ============================================================
// Stage 4: Parallel Insight Generation (8 sections)
// ============================================================

const LABEL_MAP: Record<string, string> = {
  debug_investigate: 'Debug/Investigate', implement_feature: 'Implement Feature',
  fix_bug: 'Fix Bug', write_script_tool: 'Write Script/Tool',
  refactor_code: 'Refactor Code', configure_system: 'Configure System',
  create_pr_commit: 'Create PR/Commit', analyze_data: 'Analyze Data',
  understand_codebase: 'Understand Codebase', write_tests: 'Write Tests',
  write_docs: 'Write Docs', deploy_infra: 'Deploy/Infra',
  warmup_minimal: 'Cache Warmup',
  fast_accurate_search: 'Fast/Accurate Search', correct_code_edits: 'Correct Code Edits',
  good_explanations: 'Good Explanations', proactive_help: 'Proactive Help',
  multi_file_changes: 'Multi-file Changes', handled_complexity: 'Handled Complexity',
  good_debugging: 'Good Debugging',
  misunderstood_request: 'Misunderstood Request', wrong_approach: 'Wrong Approach',
  buggy_code: 'Buggy Code', user_rejected_action: 'User Rejected Action',
  claude_got_blocked: 'Claude Got Blocked', user_stopped_early: 'User Stopped Early',
  wrong_file_or_location: 'Wrong File/Location', excessive_changes: 'Excessive Changes',
  slow_or_verbose: 'Slow/Verbose', tool_failed: 'Tool Failed',
  user_unclear: 'User Unclear', external_issue: 'External Issue',
  fully_achieved: 'Fully Achieved', mostly_achieved: 'Mostly Achieved',
  partially_achieved: 'Partially Achieved', not_achieved: 'Not Achieved',
  unclear: 'Unclear',
  unhelpful: 'Unhelpful', slightly_helpful: 'Slightly Helpful',
  moderately_helpful: 'Moderately Helpful', very_helpful: 'Very Helpful',
  essential: 'Essential',
  single_task: 'Single Task', multi_task: 'Multi Task',
  iterative_refinement: 'Iterative Refinement', exploration: 'Exploration',
  quick_question: 'Quick Question',
  happy: 'Happy', satisfied: 'Satisfied', likely_satisfied: 'Likely Satisfied',
  dissatisfied: 'Dissatisfied', frustrated: 'Frustrated',
}

function label(key: string): string { return LABEL_MAP[key] || key }
function fmtRecord(r: Record<string, number>): string {
  return Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${label(k)}: ${v}`).join(', ') || 'N/A'
}

const INSIGHT_SECTIONS: Array<{ id: string; title: string; promptFn: (d: AggregatedInsightData) => string }> = [
  {
    id: 'at_a_glance',
    title: 'At a Glance',
    promptFn: (d) => `Analyze this coding session data and give a high-level summary.

Stats: ${d.totalSessions} sessions, ${d.totalDurationHours.toFixed(1)} hours, $${d.totalCostUSD.toFixed(2)} total cost, ${(d.totalTokens.input + d.totalTokens.output).toLocaleString()} tokens
Outcomes: ${fmtRecord(d.sessionsByOutcome)}
Helpfulness: ${fmtRecord(d.sessionsByHelpfulness)}
Top tools: ${d.topTools.slice(0, 5).map(t => `${t.name}(${t.count})`).join(', ')}
Avg duration: ${d.avgDurationMinutes.toFixed(1)} min, Avg cost: $${d.avgCostPerSession.toFixed(4)}
Sessions using agents: ${d.sessionsUsingTaskAgent}, MCP: ${d.sessionsUsingMcp}, Web: ${d.sessionsUsingWebSearch + d.sessionsUsingWebFetch}
Errors: ${d.totalToolErrors}, Interruptions: ${d.totalInterruptions}

Write 2-3 short paragraphs answering:
1. **What's working well** — highlight strengths
2. **What's hindering** — identify friction
3. **Quick wins** — one concrete suggestion

Use markdown with **bold** for key points.`,
  },
  {
    id: 'project_areas',
    title: 'What You Work On',
    promptFn: (d) => `Analyze the types of coding work in these sessions.

Goal categories: ${fmtRecord(d.goalCategories)}
Session types: ${fmtRecord(d.sessionsByType)}
Languages: ${d.topLanguages.map(l => `${l.lang}(${l.count})`).join(', ')}
Success factors: ${fmtRecord(d.success)}
Lines changed: +${d.totalLinesAdded.toLocaleString()} / -${d.totalLinesRemoved.toLocaleString()} across ${d.totalFilesModified} files
Git: ${d.totalGitCommits} commits, ${d.totalGitPushes} pushes

List 4-5 main work areas with 2-3 sentences each. Include specific examples from sessions. Use markdown headers for each area.`,
  },
  {
    id: 'interaction_style',
    title: 'How You Interact',
    promptFn: (d) => `Analyze the interaction patterns.

Avg session duration: ${d.avgDurationMinutes.toFixed(1)} min
Messages per session: ~${d.avgTokensPerSession > 0 ? 'varied' : 'N/A'}
Tool success rate: ${(d.avgToolSuccessRate * 100).toFixed(0)}%
Errors: ${d.totalToolErrors}, Interruptions: ${d.totalInterruptions}
Median response time: ${d.medianResponseTime.toFixed(1)}s
Top tools: ${d.topTools.slice(0, 5).map(t => t.name).join(', ')}
Multi-clauding: ${d.multiClauding.overlapEvents} overlaps across ${d.multiClauding.sessionsInvolved} sessions
Active days: ${d.daysActive}, Messages/day: ${d.messagesPerDay}

Write 2-3 paragraphs in second person ("you"). Describe patterns: iterate quickly vs detailed specs? Interrupt often or let AI run? Use **bold** for key insights.`,
  },
  {
    id: 'what_works',
    title: "What's Working Well",
    promptFn: (d) => `Analyze what's working well.

Session outcomes: ${fmtRecord(d.sessionsByOutcome)}
Helpfulness: ${fmtRecord(d.sessionsByHelpfulness)}
Satisfaction: ${fmtRecord(d.sessionsBySatisfaction)}
Success factors: ${fmtRecord(d.success)}
Top tools: ${d.topTools.slice(0, 5).map(t => `${t.name}(${t.count})`).join(', ')}
Sessions using agents: ${d.sessionsUsingTaskAgent}
Recent sessions: ${d.sessionSummaries.slice(0, 5).map(s => `- ${s.date}: ${s.summary}`).join('\n')}

List 3 impressive workflows. For each give a short title and 2-3 sentences. Use "you" not "the user". Use markdown.`,
  },
  {
    id: 'friction_analysis',
    title: 'Friction Points',
    promptFn: (d) => `Analyze friction and problems.

Total errors: ${d.totalToolErrors}, Interruptions: ${d.totalInterruptions}
Tool success rate: ${(d.avgToolSuccessRate * 100).toFixed(0)}%
Error categories: ${fmtRecord(d.toolErrorCategories)}
Failed/abandoned: ${(d.sessionsByOutcome['not_achieved'] || 0) + (d.sessionsByOutcome['partially_achieved'] || 0)}
Friction types: ${fmtRecord(d.friction)}

List 3 friction categories. For each: explain the problem with 1-2 sentences, give 2 specific examples. Use "you" not "the user". Use markdown.`,
  },
  {
    id: 'suggestions',
    title: 'Optimization Suggestions',
    promptFn: (d) => `Based on this usage data, suggest concrete optimizations.

Total cost: $${d.totalCostUSD.toFixed(2)}, Avg/session: $${d.avgCostPerSession.toFixed(4)}
Tokens: ${(d.totalTokens.input + d.totalTokens.output).toLocaleString()}
Top models: ${d.topModels.map(m => `${m.model}(${m.sessions}s)`).join(', ')}
Top tools: ${d.topTools.slice(0, 5).map(t => t.name).join(', ')}
Languages: ${d.topLanguages.slice(0, 5).map(l => l.lang).join(', ')}
Recurring instructions: ${d.sessionSummaries.filter(s => s.goal).slice(0, 3).map(s => s.goal).join('; ')}

Provide suggestions:
1. **WZXCLAW.md additions**: What instructions would reduce repetition? Prioritize instructions the user gave in 2+ sessions.
2. **Features to try**: Agent delegation, MCP servers, custom skills, headless mode
3. **Usage patterns**: Better model routing, cost optimization

Use markdown. Be specific with copyable examples.`,
  },
  {
    id: 'on_the_horizon',
    title: 'On the Horizon',
    promptFn: (d) => `Analyze this usage data and identify future opportunities.

Current patterns: ${fmtRecord(d.sessionsByType)}
Languages: ${d.topLanguages.map(l => l.lang).join(', ')}
Agents used: ${d.sessionsUsingTaskAgent}/${d.totalSessions} sessions
Multi-clauding: ${d.multiClauding.overlapEvents} overlap events
Success areas: ${fmtRecord(d.success)}

Identify 3 future opportunities. For each: title (4-8 words), what's possible (2-3 ambitious sentences), how to try (1-2 sentences), and a copyable prompt. Think BIG — autonomous workflows, parallel agents, iterating against tests.`,
  },
  {
    id: 'fun_ending',
    title: 'Memorable Moment',
    promptFn: (d) => `Analyze this usage data and find a memorable moment.

Session summaries: ${d.sessionSummaries.slice(0, 10).map(s => `${s.date}: ${s.summary}`).join('; ')}

Find something genuinely interesting, funny, or surprising from the session summaries. Respond with JSON:
{"headline": "A memorable QUALITATIVE moment", "detail": "Brief context"}

If nothing stands out, make a witty observation about the usage patterns.`,
  },
]

export async function generateInsights(
  data: AggregatedInsightData,
  apiKey: string,
  baseUrl: string,
  model: string,
  onProgress?: (sectionId: string) => void,
): Promise<InsightSection[]> {
  const prompts = INSIGHT_SECTIONS.map(section => ({
    section,
    prompt: section.promptFn(data),
  }))

  // Run sequentially (not parallel) to avoid rate limits on GLM/DeepSeek APIs
  const results: InsightSection[] = []
  for (let i = 0; i < prompts.length; i++) {
    const { section, prompt } = prompts[i]
    onProgress?.(section.id)
    const content = await callLlmForInsight(prompt, apiKey, baseUrl, model)
    results.push({
      id: section.id,
      title: section.title,
      content: content || '*Analysis unavailable — LLM call failed.*',
    })
  }

  return results
}

// ============================================================
// Stage 5: HTML Report with Chart.js
// ============================================================

export function renderHtmlReport(data: AggregatedInsightData, sections: InsightSection[]): string {
  const dateRange = `${new Date(data.dateRange.earliest).toISOString().slice(0, 10)} — ${new Date(data.dateRange.latest).toISOString().slice(0, 10)}`
  const totalTokens = (data.totalTokens.input + data.totalTokens.output).toLocaleString()

  const sectionCards = sections.map(s => `
    <section class="card">
      <h2>${esc(s.title)}</h2>
      <div class="content">${renderMarkdown(s.content)}</div>
    </section>`).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>wzxClaw Insights</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1e1e2e; color: #cdd6f4; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 28px; margin-bottom: 4px; color: #cba6f7; }
  .subtitle { font-size: 14px; color: #6c7086; margin-bottom: 24px; }
  .stats-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 28px; }
  .stat { background: #313244; border-radius: 8px; padding: 14px 12px; text-align: center; }
  .stat-value { font-size: 20px; font-weight: 600; color: #a6e3a1; }
  .stat-label { font-size: 11px; color: #6c7086; margin-top: 2px; }
  .charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
  .chart-card { background: #313244; border-radius: 8px; padding: 16px; }
  .chart-card h3 { font-size: 13px; color: #89b4fa; margin-bottom: 8px; }
  .chart-card canvas { max-height: 220px; }
  .card { background: #313244; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 18px; color: #89b4fa; margin-bottom: 12px; }
  .content { line-height: 1.7; font-size: 14px; }
  .content p { margin-bottom: 12px; }
  .content ul, .content ol { margin-left: 20px; margin-bottom: 12px; }
  .content li { margin-bottom: 4px; }
  .content strong { color: #f9e2af; }
  .content em { color: #f38ba8; }
  .content code { background: #45475a; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .content pre { background: #1e1e2e; padding: 12px; border-radius: 6px; overflow-x: auto; margin-bottom: 12px; }
  .content pre code { background: none; padding: 0; }
  .divider { border: none; border-top: 1px solid #45475a; margin: 8px 0; }
  @media (max-width: 700px) { .charts-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>wzxClaw Insights</h1>
<p class="subtitle">${dateRange} — Generated ${new Date().toISOString().slice(0, 19)}</p>

<div class="stats-bar">
  <div class="stat"><div class="stat-value">${data.totalSessions}</div><div class="stat-label">Sessions</div></div>
  <div class="stat"><div class="stat-value">${totalTokens}</div><div class="stat-label">Total Tokens</div></div>
  <div class="stat"><div class="stat-value">$${data.totalCostUSD.toFixed(2)}</div><div class="stat-label">Total Cost</div></div>
  <div class="stat"><div class="stat-value">${data.totalDurationHours.toFixed(1)}h</div><div class="stat-label">Total Time</div></div>
  <div class="stat"><div class="stat-value">${data.avgDurationMinutes.toFixed(0)}m</div><div class="stat-label">Avg Duration</div></div>
  <div class="stat"><div class="stat-value">${(data.avgToolSuccessRate * 100).toFixed(0)}%</div><div class="stat-label">Tool Success</div></div>
  <div class="stat"><div class="stat-value">${data.totalGitCommits}</div><div class="stat-label">Git Commits</div></div>
  <div class="stat"><div class="stat-value">+${data.totalLinesAdded.toLocaleString()} / -${data.totalLinesRemoved.toLocaleString()}</div><div class="stat-label">Lines Changed</div></div>
</div>

<div class="charts-grid">
  <div class="chart-card"><h3>Session Outcomes</h3><canvas id="chartOutcome"></canvas></div>
  <div class="chart-card"><h3>Top Tools</h3><canvas id="chartTools"></canvas></div>
  <div class="chart-card"><h3>Languages</h3><canvas id="chartLang"></canvas></div>
  <div class="chart-card"><h3>Goal Categories</h3><canvas id="chartGoals"></canvas></div>
</div>

${sectionCards}

<script>
const colors = ['#a6e3a1','#89b4fa','#f9e2af','#f38ba8','#cba6f7','#94e2d5','#fab387','#74c7ec','#b4befe','#eba0ac'];
const chartOpts = { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#6c7086' }, grid: { color: '#45475a' } }, y: { ticks: { color: '#6c7086' }, grid: { color: '#45475a' } } } };

new Chart(document.getElementById('chartOutcome'), { type: 'bar', data: { labels: [${Object.keys(data.sessionsByOutcome).map(k => `'${label(k)}'`).join(',')}], datasets: [{ data: [${Object.values(data.sessionsByOutcome).join(',')}], backgroundColor: colors }] }, options: chartOpts });
new Chart(document.getElementById('chartTools'), { type: 'bar', data: { labels: [${data.topTools.slice(0, 8).map(t => `'${t.name}'`).join(',')}], datasets: [{ data: [${data.topTools.slice(0, 8).map(t => t.count).join(',')}], backgroundColor: colors }] }, options: chartOpts });
new Chart(document.getElementById('chartLang'), { type: 'doughnut', data: { labels: [${data.topLanguages.slice(0, 8).map(l => `'${l.lang}'`).join(',')}], datasets: [{ data: [${data.topLanguages.slice(0, 8).map(l => l.count).join(',')}], backgroundColor: colors }] }, options: { responsive: true, plugins: { legend: { position: 'right', labels: { color: '#cdd6f4', font: { size: 11 } } } } } });
new Chart(document.getElementById('chartGoals'), { type: 'bar', data: { labels: [${Object.keys(data.goalCategories).slice(0, 8).map(k => `'${label(k)}'`).join(',')}], datasets: [{ data: [${Object.values(data.goalCategories).slice(0, 8).join(',')}], backgroundColor: colors }] }, options: chartOpts });
<\/script>
</body>
</html>`
}

export async function saveAndOpenReport(html: string, reportDir: string): Promise<string> {
  await fsp.mkdir(reportDir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const htmlPath = path.join(reportDir, `report-${timestamp}.html`)
  await fsp.writeFile(htmlPath, html, 'utf-8')

  // Prune old reports (keep last 5)
  try {
    const files = await fsp.readdir(reportDir)
    const reports = files.filter(f => f.startsWith('report-') && f.endsWith('.html'))
    if (reports.length > 5) {
      reports.sort()
      const toDelete = reports.slice(0, reports.length - 5)
      await Promise.all(toDelete.map(f => fsp.unlink(path.join(reportDir, f)).catch(() => {})))
    }
  } catch { /* prune failure is non-blocking */ }

  await shell.openPath(htmlPath)
  return htmlPath
}

/**
 * Build the full insight result.
 */
export async function buildInsightReport(
  data: AggregatedInsightData,
  sections: InsightSection[],
  reportDir: string,
): Promise<InsightResult> {
  const html = renderHtmlReport(data, sections)
  const htmlPath = await saveAndOpenReport(html, reportDir)

  const topOutcome = Object.entries(data.sessionsByOutcome).sort((a, b) => b[1] - a[1])[0]
  const summary = [
    `Analyzed **${data.totalSessions} sessions** ($${data.totalCostUSD.toFixed(2)} total cost, ${(data.totalTokens.input + data.totalTokens.output).toLocaleString()} tokens).`,
    `Most common outcome: **${topOutcome ? label(topOutcome[0]) : 'N/A'}** (${topOutcome?.[1] || 0} sessions). Tool success rate: **${(data.avgToolSuccessRate * 100).toFixed(0)}%**.`,
    `Average session: **${data.avgDurationMinutes.toFixed(0)} minutes**. Lines changed: +${data.totalLinesAdded.toLocaleString()} / -${data.totalLinesRemoved.toLocaleString()}.`,
    `Full report opened in browser: \`${htmlPath}\``,
  ].join('\n')

  return { summary, htmlPath, totalSessions: data.totalSessions, totalCostUSD: data.totalCostUSD }
}

// ============================================================
// Helpers
// ============================================================

function topN(r: Record<string, number>, n: number): Array<{ name: string; count: number }> {
  return Object.entries(r).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }))
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderMarkdown(md: string): string {
  let html = esc(md)
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // Italic
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>')
  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>')
  html = '<p>' + html + '</p>'
  html = html.replace(/<p>\s*<\/p>/g, '')
  return html
}

async function callLlmForInsight(prompt: string, apiKey: string, baseUrl: string, model: string): Promise<string | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const MAX_RETRIES = 3

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000)
        console.log(`[insights] callLlmForInsight retry ${attempt}/${MAX_RETRIES} after ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
      }
      console.log(`[insights] callLlmForInsight → ${url} model=${model} attempt=${attempt}`)
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are an AI coding assistant usage analyst. Write clear, actionable analysis in markdown. Use second person ("you"). Be specific with examples.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2048,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        if (resp.status === 429 && attempt < MAX_RETRIES) {
          console.warn(`[insights] callLlmForInsight HTTP 429 (rate limited), will retry...`)
          continue
        }
        console.error(`[insights] callLlmForInsight HTTP ${resp.status}: ${body.slice(0, 500)}`)
        return null
      }
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
      return data.choices?.[0]?.message?.content ?? null
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.warn(`[insights] callLlmForInsight error (will retry):`, err)
        continue
      }
      console.error(`[insights] callLlmForInsight error (final):`, err)
      return null
    }
  }
  return null
}
