# 05-Skills — 渐进式上下文展开

## 1. 概述

Skills 是一种 **懒加载的能力包**，解决核心矛盾：Agent 需要知道自己能做什么，但把所有能力的详细说明都塞进 Context 又太浪费。

核心思想：**注册时只放名字和一句话描述，调用时才展开完整指令。**

```
没有 Skills：System Prompt = 基础指令 + PDF处理 + CSV分析 + 部署流程 = 爆炸
有 Skills：  System Prompt = 基础指令 + "可用 Skills: pdf, csv, deploy" = 紧凑
             调用时展开 → 按需注入完整指令
```

Skills 之于 Agent ≈ 懒加载模块之于前端 — 用到时才下载。

## 2. Agent Loop 中的位置

Skills 在 Agent Loop 中表现为一个 **特殊的虚拟工具**，不执行实际操作，而是将指令注入 Context。

```
构建工具列表：
  tools = [FileRead, FileWrite, Bash, Grep, ..., Skill]
                                                  ↑
                                          单工具，内含可用 Skills 列表

模型决策阶段：
  User: "Extract text from report.pdf"
  Model 看到 Skill tool + available_skills 列表
  Model 决定: tool_use Skill({command: "pdf"})

展开阶段：
  Harness 加载 SKILL.md → 完整指令作为 tool_result 返回
  → 500-2000 tokens 详细指令注入 Context

执行阶段：
  Model 按指令调用内置工具（Bash, FileRead）→ 完成实际任务
```

## 3. 注册阶段 vs 展开阶段

### 3.1 注册阶段（轻量）

只在工具定义中放入极简信息，让模型知道 "有什么可用"。

```typescript
const skillToolDefinition = {
  name: "Skill",
  description: "Invoke a specialized capability.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", enum: availableSkillNames },
      args: { type: "object" }
    },
    required: ["command"]
  },
  available_skills: [
    { name: "pdf",     description: "Extract and analyze text from PDF documents" },
    { name: "csv",     description: "Analyze and visualize CSV data" },
    { name: "deploy",  description: "Deploy application to cloud platforms" },
  ]
}
// 每个 Skill ~25 tokens，3 个 Skills ~75 tokens
// 对比：直接展开 3 个 Skills 可能 5000+ tokens
```

### 3.2 展开阶段（按需）

```typescript
async function executeSkill(command: string, args?: Record<string, any>): Promise<ToolResult> {
  const skillDir = findSkillDir(command)
  const skillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
  const { frontmatter, body } = parseFrontmatter(skillMd)
  const expandedBody = body
    .replace('{{args}}', JSON.stringify(args ?? {}))
    .replace('{{cwd}}', process.cwd())
  return { content: expandedBody, isError: false }  // 500-2000 tokens
}
```

### 3.3 对比

```
注册阶段: Skill tool + 3 个描述 → ~75 tokens
展开阶段: Model 调用 Skill("pdf") → SKILL.md 全文注入 → ~800 tokens
节省:     5 个 Skill 注册 ~125 tokens (vs 全量展开 ~5000 tokens)
```

## 4. 文件结构

```
~/.wzxclaw/skills/              (全局)
.wzxclaw/skills/                (项目级，优先级更高)

├── pdf/
│   ├── SKILL.md                # frontmatter (name, desc) + body (instructions)
│   ├── extract_text.py         # 辅助脚本
│   └── templates/
└── csv/
    ├── SKILL.md
    └── analyze.py
```

SKILL.md 格式：

```markdown
---
name: pdf
description: Extract and analyze text from PDF documents
tags: [document, extraction, ocr]
requires: [python3, pymupdf]
---

# PDF Extraction Skill
## Steps
1. Detect PDF type: `python3 {{skill_dir}}/detect_type.py "{{file_path}}"`
2. Text PDF: `python3 {{skill_dir}}/extract_text.py "{{file_path}}"`
3. Scanned PDF: `python3 {{skill_dir}}/ocr_extract.py "{{file_path}}"`

## Error Handling
- PyMuPDF missing: `pip install pymupdf`
- OCR needed: `pip install pytesseract`
```

## 5. 运行时触发流

完整调用链路追踪：

```
1. User 发送消息
   User: "Extract text from quarterly_report.pdf and summarize financial data"

2. 模型第一次调用 — 检查可用能力
   Model 看到: Skill tool + available_skills: { pdf: "Extract text from PDFs" }
   Model 决定: tool_use Skill({ command: "pdf", args: { file_path: "quarterly_report.pdf" } })

3. Harness 执行 Skill 工具
   → 加载 SKILL.md → 替换模板变量 → 作为 tool_result 返回完整指令

4. 模型第二次调用 — 按指令执行
   Model 拥有完整 PDF 指令：
     tool_use Bash({ command: "python3 ~/.wzxclaw/skills/pdf/detect_type.py quarterly_report.pdf" })
     → tool_result: "text-based, 24 pages"
     tool_use Bash({ command: "python3 ~/.wzxclaw/skills/pdf/extract_text.py quarterly_report.pdf" })
     → tool_result: [24 pages of text]

5. 模型第三次调用 — 生成结果
   "Here's the summary: Revenue $2.3M (up 15% QoQ), Operating costs $1.8M ..."
```

Harness 端注册：

```typescript
function registerSkillTool(harness: AgentHarness, skillDirs: string[]) {
  const availableSkills = new Map<string, SkillManifest>()
  for (const dir of skillDirs) {
    const manifest = parseSkillManifest(dir)
    if (manifest) availableSkills.set(manifest.name, manifest)
  }

  harness.registerTool({
    name: 'Skill',
    description: buildSkillDescription(availableSkills),  // 极简列表
    inputSchema: { type: "object", properties: { command: { enum: [...availableSkills.keys()] } } },
    execute: async ({ command, args }) => {
      const skill = availableSkills.get(command)
      return { content: await loadSkillContent(skill, args) }
    }
  })
}
```

## 6. 与 MCP 的对比

```
┌──────────────┬─────────────────────┬──────────────────────┐
│ 维度          │ MCP Tools           │ Skills               │
├──────────────┼─────────────────────┼──────────────────────┤
│ 加载时机      │ 启动时全量加载        │ 按需加载              │
│ Context 占用  │ 完整 schema 常驻      │ 仅描述，展开时注入     │
│ 本质          │ 外部动作执行          │ Prompt 扩展           │
│ Token 成本    │ ~2-5K / server      │ ~25 / skill          │
│ 执行方式      │ 进程间通信            │ 模型按指令调内置工具    │
│ 运行时依赖    │ MCP Server 进程      │ 无（只用内置工具）     │
│ 适用场景      │ API 调用、外部服务    │ 复杂流程、分析任务     │
└──────────────┴─────────────────────┴──────────────────────┘
```

互补关系：MCP 侧重 "能做什么"（能力扩展），Skills 侧重 "怎么做"（知识扩展）。组合使用：deploy Skill 展开部署指令 → 指令中调用 mcp_aws_deploy 工具 → MCP 执行实际部署。

## 7. Agent Skills 开源标准

2025 年 12 月 Claude Code 推出 Agent Skills 开源标准，目标一次编写、处处可用。

```
标准化要点：
├── 统一 SKILL.md 格式（frontmatter + body）
├── 标准目录结构
├── 跨 AI Agent 兼容（Claude Code, Cursor, Windsurf）
└── 可发布的 Skill 包（npm / pip 分发）
```

wzxClaw 中三种可扩展能力互补：
- **Slash Commands**（`~/.wzxclaw/commands/*.md`）：始终加载，适合简单高频指令
- **Skills**（`~/.wzxclaw/skills/*/SKILL.md`）：按需加载，适合复杂低频任务
- **MCP Tools**（`~/.wzxclaw/mcp.json`）：schema 常驻，适合 API 调用和外部集成

## 8. 设计启示

Skills 的核心设计模式——**三级上下文管理**——可以泛化：

```
Level 0: 索引层 — "我知道有什么"   (~25 tokens/item, 始终在 Context)
Level 1: 指令层 — "我知道怎么做"   (~500-2000 tokens, 按需加载)
Level 2: 执行层 — "我正在做"       (动态大小, 临时在 Context)
```

任何 "大量可选能力" 的管理都适用此模式。
