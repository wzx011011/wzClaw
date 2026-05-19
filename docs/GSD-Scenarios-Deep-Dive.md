# GSD 常见场景深度指南

## 场景 1：从零开始新项目

**适用于**：新特性、新模块、新产品线启动

### 工作流

```
gsd new-project
    ↓
gsd discuss-phase
    ↓
gsd spec-phase (如果涉及AI或UI则分别做 ai-integration-phase / ui-phase)
    ↓
gsd plan-phase
    ↓
gsd execute-phase
    ↓
gsd verify-work (UAT)
    ↓
gsd ship (PR → 合并)
    ↓
gsd complete-milestone
```

### 详细步骤

#### Step 1: `gsd new-project` — 初始化项目

**输入**：项目愿景、关键里程碑、技术栈选择
**输出**：

- `PROJECT.md` — 项目概览（目标、成功指标、团队、风险）
- `ROADMAP.md` — 3-5 个版本的阶段分解（M1、M2、M3...）
- `.planning/` 目录结构

**做什么**：

1. 回答：这是什么产品？为什么做？对谁有价值？
2. 定义成功指标（用户增长、性能、成本等）
3. 粗略分解为里程碑（每个 2-4 周）
4. 选择第一个 milestone 的核心 3-5 个阶段

**示例**（wzxClaw 的 M1）：

```
M1.Agent Loop Harness — 核心智能体循环
  ├─ Phase 1.1: LLM 多后端网关 (OpenAI, Anthropic, DeepSeek)
  ├─ Phase 1.2: 工具注册表 + 权限框架
  ├─ Phase 1.3: 会话持久化 + 上下文压缩
  ├─ Phase 1.4: Electron IPC 集成
  └─ Phase 1.5: Mobile WebSocket 中继
```

---

#### Step 2: `gsd discuss-phase` — 梳理需求背景

**输入**：Phase 目标、现有资源、团队背景
**输出**：

- 会话记录 + 结构化背景文档
- 确认的假设、依赖、约束

**三种模式**（交互中选择）：

1. **assumptions 模式** — 深挖代码库假设
2. **advisor 模式** — 灰色决策建议对比
3. **default 模式** — 标准需求澄清

**做什么**：

1. 与 Claude 对话梳理：WHY + WHO + WHAT
2. 理清阶段与其他阶段的依赖
3. 列举已知约束（时间、资源、技术限制）
4. 确认假设是否合理（尤其是架构假设）

**示例问题**：

- Phase 1.1 的 LLM 多后端支持，是否需要在启动时选择，还是运行时切换？
- 是否需要支持本地离线模型（ollama）？
- Token 计数的精度要求？
- 超时处理策略？

---

#### Step 3: `gsd spec-phase` — 澄清需求

**输入**：discuss-phase 的背景
**输出**：

- `SPEC.md` — 需求规范
- 歧义评分（LOW/MEDIUM/HIGH）

**做什么**：

1. 化模糊承诺为可测试的需求
2. 列举非功能需求（性能、安全、可维护性）
3. 评估需求中的歧义风险
4. 识别 spike/调研任务

**SPEC.md 结构**：

```markdown
# Phase 1.1: LLM 多后端网关 SPEC

## 目标

支持 OpenAI, Anthropic, DeepSeek, 国产GLM 四家 LLM 后端，统一接口，运行时切换。

## 交付物

- LLMGateway 类（src/main/llm/gateway.ts）
- 4 个后端适配器（openai-adapter.ts, anthropic-adapter.ts, ...)
- 单元测试 (coverage > 80%)

## 需求

### 功能需求

1. 支持流式 (streaming) 和非流式 (non-streaming) 两种模式
2. 请求参数规范化（model, messages, temperature, top_p, max_tokens）
3. 响应统一为 LLMMessage 对象
4. 故障降级：A 后端超时 → 自动重试最多 3 次 → 切换到 B 后端
5. 支持提示词缓存（仅 Anthropic）

### 非功能需求

- 单次流式请求 < 200ms 首字节延迟（除首次连接）
- 支持 200k 以上 token 单次请求
- 日志可观测性（Langfuse 集成）

### 不在 scope

- 本地离线模型（ollama）— Phase 2.X 考虑
- 模型微调 — 超出范围

## 歧义评分

- "运行时切换"的 UX（Slider? 下拉菜单? 命令行?）— MEDIUM
- 缓存策略与 Token 计数的交互 — HIGH （需要 spike）

## 风险

- 第三方 API 不稳定 → 降级策略
- Token 计数算法差异 → 自有计数库 (js-tiktoken)
```

---

#### Step 4: `gsd plan-phase` — 详细规划

**输入**：SPEC.md
**输出**：

- `PLAN.md` — 任务分解
- 关键任务：6-12 个独立工作项
- 依赖关系、估时、验收标准

**PLAN.md 结构**（简化）：

```markdown
# Phase 1.1 计划

## 任务分解

### Task 1.1.1: LLMGateway 基础架构

- 创建 Gateway 类，注册 4 个适配器
- 实现适配器接口 (ILLMAdapter)
- **验收**：单元测试 > 80%, TypeScript 无错
- **依赖**：无
- **估时**：2d
- **优先级**：P0 (blocker)

### Task 1.1.2: OpenAI 适配器

- 实现 OpenAI SDK 包装
- 支持流式 + 非流式
- **验收**：集成测试通过（mock API）
- **依赖**：Task 1.1.1
- **估时**：1.5d

### Task 1.1.3: Anthropic 适配器 + 缓存

- 实现 Anthropic SDK 包装
- 实现提示词缓存逻辑
- **验收**：E2E 测试，缓存命中率验证
- **依赖**：Task 1.1.1, 缓存库调研 (spike)
- **估时**：2d

### Task 1.1.4: DeepSeek + GLM 适配器

- 两个适配器实现
- **验收**：集成测试
- **依赖**：Task 1.1.1
- **估时**：1.5d

### Task 1.1.5: 故障降级 + 重试逻辑

- 实现 3 次重试 + 后端切换
- 指数退避
- **验收**：单元测试（mock 各种失败场景）
- **依赖**：Task 1.1.2, 1.1.3, 1.1.4
- **估时**：1.5d

### Task 1.1.6: Langfuse 可观测性集成

- 上报每次 LLM 调用
- 记录 token 用量、延迟、错误
- **验收**：Langfuse UI 可查看链路
- **依赖**：所有任务完成
- **估时**：1d

### Task 1.1.7: 集成测试 + E2E

- 真实 API 集成测试（使用测试 key）
- Playwright E2E（UI 切换后端）
- **验收**：所有测试 pass
- **依赖**：所有任务完成
- **估时**：2d

## 关键路径分析

最长链：Task 1.1.1 → Task 1.1.3 + Task 1.1.4 + Task 1.1.5 → Task 1.1.6 → Task 1.1.7
总耗时：2 + 2 + 1.5 + 1 + 2 = 8.5d

## 验收标准

1. 所有 4 个后端适配器都通过集成测试
2. 故障转移在 < 30s 内完成
3. 单元测试覆盖 > 85%
4. Langfuse 链路完整上报
5. 没有 TypeScript 类型错误
6. Code Review 通过
```

---

#### Step 5: `gsd execute-phase` — 落地实现

**输入**：PLAN.md 的所有任务
**输出**：

- 功能代码
- 单元测试
- 集成测试
- git commit 记录

**执行模式**：

1. **波形并行**（Wave）：不依赖的任务并行
   - Wave 1：Task 1.1.1 (基础)
   - Wave 2：Task 1.1.2 + 1.1.3 + 1.1.4 (3 个适配器并行)
   - Wave 3：Task 1.1.5 (降级逻辑，依赖前面都完)
   - Wave 4：Task 1.1.6 + 1.1.7 (可观测性 + 集成测试)

2. **偏离处理**：遇到超出 scope 的新需求？
   - 记录到 ROADMAP 未来阶段
   - 或与 PM 确认是否加入当前 scope（工期顺延）

3. **检查点**：
   - 每日 code review
   - 隔日集成测试
   - 中期（Day 4）评估是否在轨（若偏离 > 20% 及时回滚或调整）

**做什么**：

```bash
# 启动 execute
gsd execute-phase

# 接下来按任务逐个完成，commit 后标记完成
# execute 代理会自动：
# 1. 追踪完成状态
# 2. 并行无依赖任务
# 3. 保存检查点
# 4. 处理偏离和 blocker
```

---

#### Step 6: `gsd verify-work` — UAT 验证

**输入**：execute-phase 完成的代码
**输出**：

- UAT 报告（通过/失败/缺陷）
- 修复或遗留问题列表

**验证项**（对标 SPEC）：

1. ✓ 4 个后端都可正常切换
2. ✓ 流式输出延迟 < 200ms 首字节
3. ✓ 故障自动转移（模拟 API 超时）
4. ✓ Token 计数准确
5. ✓ Langfuse 链路完整
6. ✓ 无类型错误、Linter 通过

**不达标处理**：

- 若是边界 case → Phase 2 backlog
- 若是严重缺陷 → 返回 execute，修复后重新 verify

---

#### Step 7: `gsd ship` — 提交 PR

**输入**：verify-work 通过
**输出**：

- GitHub PR（自动添加 checklist）
- Code review 通过
- 准备合并

**流程**：

```bash
gsd ship
# 自动：
# 1. 创建 feature 分支
# 2. 过滤 .planning/ 提交
# 3. 生成 PR 描述（自动引用 SPEC + PLAN）
# 4. 邀请 reviewer
# 5. 等待 CI/CD 通过
```

---

#### Step 8: `gsd complete-milestone` — 完成里程碑

**输入**：所有 Phase 都 ship 完
**输出**：

- M1 归档（.planning/milestones/M1/）
- M2 ROADMAP 解锁
- Release Notes

**做什么**：

```bash
gsd complete-milestone
# 自动：
# 1. 生成 M1 总结（统计、学习、决策）
# 2. 创建 Release v0.1.0 标签
# 3. 初始化 .planning/milestones/M2/
```

---

### 整体周期

- **总耗时**：4-6 周（取决于 Phase 数量和复杂度）
- **输出物**：功能代码、文档、测试、链路
- **成本**：主要是 code review + UAT 反复

---

## 场景 2：维护 + 调试现有项目

**适用于**：生产环保修复、性能优化、技术债清偿

### 工作流

```
问题发现
    ↓
gsd debug (根因分析)
    ↓
gsd code-review (代码质量扫描)
    ↓
实现修复
    ↓
gsd verify-work (局部 UAT)
    ↓
gsd ship (hotfix PR)
```

### 详细步骤

#### Step 1: 问题发现 → `gsd debug`

**输入**：用户报告的问题 / 监控告警
**场景举例**：

- 界面卡顿（流式消息导致 SessionList 频繁重渲）
- `Cannot read properties of undefined (reading 'map')` 错误
- 内存泄漏（IPC 消息积压）
- 性能退化（Token 计数算法复杂度爆炸）

**Debug 流程**：

```bash
gsd debug --category [性能|崩溃|内存|业务逻辑]
```

**输出** (DBUG.md)：

- 执行链路图（哪些函数被调用）
- 变量状态追踪（某个关键变量如何从 OK 变成异常）
- 假设与验证（这是 BUG 吗？还是设计问题？）
- 根因确认

**实例**（之前 Session 卡顿的调试）：

```
问题：流式输出时 SessionList 频繁重渲

调试链路：
1. Renderer: chat-store 订阅 messages 字段
2. Main: 每个流式 token → IPC: agent:stream 事件
3. Renderer: DataSourceProvider 接收 → 调用 setState
4. React: 全 store 更新 → SessionList 收到更新
5. Bug: SessionList 虽然用 messages，但因为订阅了全 store，导致每次都重渲

根因：组件订阅粒度太粗

修复：
- 改为仅订阅 sessions + conversationId
- 消息流不触发 SessionList 更新
```

**输出**：

- `DBUG.md` — 调试过程记录
- `.planning/debug-checkpoints/` — 断点保存（支持跨 context 恢复）

---

#### Step 2: 实现修复

基于 debug 结果，编写修复代码：

```bash
# 修复代码
# 例如：packages/web-ui/src/components/chat/SessionList.tsx
# - 改 useSelector 订阅粒度
# - 或改 ipc-source.ts 的数据转换

# 编写回归测试
npm test -- SessionList.test.ts
```

---

#### Step 3: `gsd code-review` — 扫描代码质量

**输入**：修复 commit
**输出**：`REVIEW.md`（结构化缺陷报告）

**扫描维度**：

- **Bugs**（逻辑错误、类型不匹配）
- **Security**（XSS、SQL 注入、认证漏洞）
- **Performance**（O(n²) 循环、内存泄漏、频繁重新计算）
- **Maintainability**（命名混乱、魔法数字、注释不足）

**示例输出**：

```markdown
# REVIEW.md

## HIGH 严重

1. [性能] SessionList useEffect 中 setState 仍在高频触发
   - 行号：src/components/chat/SessionList.tsx:123
   - 建议：改用 useMemo 包装选择器

## MEDIUM 中等

1. [Maintainability] 常数 "5000" 没有名字
   - 行号：src/stores/chat-store.ts:89
   - 建议：提取为 STREAM_BUFFER_TIMEOUT_MS

## LOW 低

1. [Style] 函数签名太长（4 个参数）
   - 行号：...
   - 建议：改为 options 对象参数
```

**Follow-up**：

```bash
# HIGH 和 MEDIUM 必须修复，LOW 可 defer
# 修复后重新 review
gsd code-review --mode fix  # 自动尝试修复
```

---

#### Step 4: 局部 UAT → `gsd verify-work`

**输入**：修复完的代码
**输出**：修复确认报告

**验证**：

1. 原问题是否已解决？（流式输出时 SessionList 不抖动）
2. 是否引入新 bug？（运行全测试套件）
3. 性能是否改善？（对比修复前后的时间指标）

```bash
# 单元测试
npm test -- ipc-source.test.ts chat-store-session.test.ts

# 集成测试
npm run test:e2e -- chat.spec.ts

# 性能基准测试（可选）
npm run test:perf
```

---

#### Step 5: Hotfix PR → `gsd ship`

**输入**：验证通过的修复
**输出**：Hotfix PR

```bash
gsd ship --type hotfix
# 自动：
# 1. 分支名：fix/session-list-rerender
# 2. PR 标题：[HOTFIX] 修复会话列表流式输出卡顿
# 3. 描述：根因 + 修复 + 性能对比
# 4. 标签：bugfix, performance
# 5. CI/CD check
```

---

### 维护流程的关键指标

| 指标           | 目标    |
| -------------- | ------- |
| 问题响应时间   | < 4h    |
| Debug 到根因   | < 2h    |
| 修复验证       | < 1h    |
| Hotfix PR 合并 | < 30min |
| 总 TTR（平均） | < 4h    |

---

## 场景 3：AI 系统设计（Agent Loop / LLM 集成）

**适用于**：新的智能体架构、LLM 接入、Evaluation 框架

### 工作流

```
gsd discuss-phase
    ↓
gsd ai-integration-phase (设计 AI-SPEC)
    ├─ 框架选型（LangChain vs LlamaIndex vs 自研）
    ├─ 域评估（什么场景下好用、什么场景失败）
    ├─ 评估策略（如何度量成功）
    └─ 生产监控（成本、延迟、错误率）
    ↓
gsd plan-phase
    ↓
gsd execute-phase
    ↓
gsd eval-review (评估覆盖审计)
    ↓
gsd verify-work
    ↓
gsd ship
```

### AI-SPEC.md 结构

````markdown
# AI-SPEC: Agent Loop 架构 v2

## 问题陈述

当前 Agent Loop 支持单轮 LLM 调用 + 工具执行，但在复杂多步推理（如代码审查、架构设计）时显得不够灵活。
需要支持：

1. 多智能体协作（专家智能体分工）
2. 动态工具图（工具之间的依赖和反馈循环）
3. Human-in-the-loop（某些决策需要人工确认）
4. 失败自动恢复（单工具失败不导致全链路中断）

## 框架选型

### 候选方案

1. **LangChain** — 生态丰富，但框架复杂，控制粒度不够
2. **LlamaIndex** — 偏向数据检索，不适合代码智能体
3. **自研** — 基于当前 AsyncGenerator 架构扩展，保持现有优势

### 推荐

**自研扩展**（理由）：

- 当前代码已支持 AsyncGenerator + 流式输出，改造成本最低
- 完全掌控执行流程，便于集成权限系统
- 支持 Electron IPC、WebSocket 两种通信，框架无法做到
- 对标：Claude Projects 就是自研框架，不用开源方案

### Quick Reference

```typescript
// 当前
const agentLoop = new AgentLoop(gateway, toolRegistry, contextManager);
for await (const event of agentLoop.run(message)) {
  yield event;  // StreamEvent
}

// v2（多智能体）
const agentA = new Agent('code-reviewer', tools: [readFile, analyzeAST]);
const agentB = new Agent('test-writer', tools: [writeTest, runTest]);
const orchestrator = new AgentOrchestrator([agentA, agentB]);
for await (const event of orchestrator.run(codeReviewTask)) {
  yield event;  // OrchestratorEvent { agent, type, data }
}
```
````

## 评估策略（关键）

### 维度 1：准确性（Correctness）

- **代码审查任务** — 人工对比：AI 找到的 bug vs 实际 bug 覆盖率
- **架构设计任务** — 评估是否遵循最佳实践（s/o:expert review)
- 目标：> 80% recall，< 10% false positive

### 维度 2：效率（Efficiency）

- **延迟** — 平均每步 < 5s（包括 LLM + 工具执行）
- **成本** — 平均每任务 < $0.1（根据 token 用量估算）
- 目标：延迟 < 5s，成本 < $0.1

### 维度 3：可靠性（Reliability）

- **工具执行成功率** — > 95%
- **会话中断恢复** — 支持 checkpoint 恢复，< 10s 恢复时间
- **错误率** — < 0.1%

### 维度 4：可观测性（Observability）

- **Langfuse 链路完整性** — 每次请求都能追踪完整链路
- **日志覆盖** — 所有关键决策点都记录日志
- **性能监控** — 采样 1% 请求做性能 profile

### 维度 5：伦理与安全（Ethics & Safety）

- **提示词注入防护** — 测试 100 条 adversarial 输入，0 个漏洞
- **隐私** — 用户代码不持久化到 NAS（本地计算）
- **审计** — 所有智能体决策都可审计

### 维度 6：用户满意度（UX）

- **可用性** — 新用户 < 5min 上手
- **可控性** — 用户可在任意时刻 cancel / retry / modify
- 目标：NPS > 8

## 生产监控

### 关键指标（KPI）

```
LATENCY:        p50 < 3s, p99 < 15s
TOKEN_COST:     avg $0.05 per task
ERROR_RATE:     < 0.1%
TOOL_SUCCESS:   > 95%
LLM_ACCURACY:   > 80%
USER_SATISFACTION: NPS > 8
```

### 告警规则

```
- latency_p99 > 20s       → Page
- error_rate > 1%          → Page
- tool_success < 90%       → Alert
- token_cost > $0.2/task   → Warn
```

### Dashboard（Langfuse + Grafana）

- 实时: 当前活跃任务数、失败率、平均延迟
- 日报: token 成本、准确率趋势、用户满意度
- 周报: 主要失败 pattern、优化机会

## 技术细节

### 多智能体协作

```typescript
// Orchestrator 负责任务分发
class AgentOrchestrator {
  async *run(task: Task): AsyncGenerator<Event> {
    // 1. 解析任务 → 识别所需能力
    const agents = this.selectAgents(task);

    // 2. 构建执行图（DAG）
    const dag = this.buildExecutionDAG(task, agents);

    // 3. 按拓扑顺序执行，每个智能体支持并行
    for (const wave of dag.waves) {
      const results = await Promise.all(
        wave.tasks.map(t => this.executeAgent(t.agent, t.input))
      );
      yield { type: 'agent:complete', agent: ..., result: ... };
    }
  }
}
```

### 动态工具图

```typescript
// 工具之间可以有依赖和反馈
type ToolExecutionMode = 'serial' | 'parallel' | 'conditional' | 'loop'

interface ToolNode {
	id: string
	tool: Tool
	mode: ToolExecutionMode
	dependencies: string[] // 依赖的其他工具 ID
	condition?: (context) => boolean // 条件执行
	maxRetries: number
	fallback?: Tool // 失败降级
}
```

### Human-in-the-loop

```typescript
// 某些决策需要人工确认
class HumanApprovalTool implements Tool {
  async execute(context: ToolContext): Promise<ToolResult> {
    yield { type: 'awaiting-approval', message: '需要确认代码修改' };
    const approval = await context.waitForUserInput();
    if (!approval) {
      return { success: false, reason: 'User rejected' };
    }
    // ...
  }
}
```

## 风险与缓解

| 风险                         | 影响   | 缓解                                         |
| ---------------------------- | ------ | -------------------------------------------- |
| LLM 幻觉导致错误建议         | HIGH   | 评估集中在准确性维度，设置 > 80% recall 门槛 |
| 成本爆炸（大 Token 用量）    | MEDIUM | Token 预算、采样日志、成本告警               |
| 用户隐私泄露（代码上传 NAS） | HIGH   | 本地计算 Agent，只上传必要的结果             |
| 性能下降（单步 > 10s）       | MEDIUM | 并行工具执行、缓存、采样 Profile             |

## 阶段计划

### Phase 1: 多智能体框架（Week 1-2）

- 实现 AgentOrchestrator
- 支持顺序 + 并行执行
- 单元测试

### Phase 2: 动态工具图（Week 3）

- ToolGraph 实现
- 条件执行 + 循环支持
- 集成测试

### Phase 3: Human-in-the-loop（Week 4）

- ApprovalTool 实现
- Renderer 交互组件
- E2E 测试

### Phase 4: 评估 & 生产监控（Week 5）

- Langfuse 链路完整
- Dashboard 部署
- 生产前评估

```

---

## 场景 4：UI/UX 工作

**适用于**：新 UI 模块、交互流重设计、设计系统更新

### 工作流

```

gsd discuss-phase
↓
gsd ui-phase (生成 UI-SPEC 设计规范)
├─ 6 维度设计审查
├─ 可访问性 (Accessibility)
├─ 响应式设计
├─ 暗黑模式
├─ 动画 & 过渡
└─ 一致性与设计系统
↓
gsd plan-phase
↓
gsd execute-phase
↓
gsd ui-review (6 维度视觉审计)
↓
gsd verify-work
↓
gsd ship

````

### UI-SPEC.md 结构

```markdown
# UI-SPEC: 聊天主界面重设计

## 设计愿景
当前界面信息密度过高，导致视觉疲劳。目标是通过
- 精简主要操作区
- 分层展示消息流
- 强化用户焦点（当前任务）
来提升交互体验。

## 6 维度设计标准

### 1. 可用性 (Usability)
- **认知负荷** — 首屏最多 5 个主操作（少于当前 12 个）
- **任务完成时间** — 完成一个聊天任务 < 2min（不含 LLM 推理）
- **错误率** — 误点击率 < 5%

### 2. 可访问性 (Accessibility)
- **WCAG 2.1 AA** — 通过自动化检查
- **键盘导航** — 支持 Tab、Space、Enter
- **屏幕阅读器** — 所有交互都有 aria-label

### 3. 响应式设计 (Responsive)
- **断点** — 支持 320px(mobile), 768px(tablet), 1920px(desktop)
- **布局** — mobile 单列、tablet 双列、desktop 三栏
- **触摸友好** — 按钮最小 44x44px

### 4. 暗黑模式 (Dark Mode)
- **色彩对比** — WCAG AA 标准（对比度 > 4.5:1）
- **图标** — 暗黑模式自动反色或自定义
- **渐进增强** — 自动检测 `prefers-color-scheme`

### 5. 动画 & 过渡 (Motion)
- **性能** — 所有动画 60fps，GPU 加速
- **可访问性** — 支持 `prefers-reduced-motion`，自动禁用动画
- **延迟** — 状态变化 < 300ms

### 6. 一致性 & 设计系统 (Consistency)
- **色板** — 使用全局 8 种颜色 + 2 种中性色
- **排版** — 标准 3 层标题、正文字号、代码字体
- **间距** — 8px 基线（8, 16, 24, 32, 40...）
- **圆角** — 3 种：sm(4px), md(8px), lg(12px)

## 原型与流程

### 关键页面
1. **聊天列表** — 显示所有会话（支持搜索、分组）
2. **聊天详情** — 消息流 + 右侧工具栏
3. **设置面板** — 模型选择、API Key 配置

### 用户流
````

启动 → 会话列表 → 选择会话 → 消息流 → 输入框 → 发送
新建 ↓
新会话对话框

````

### 设计资源
- Figma 链接：[设计稿](https://figma.com/...)
- 颜色 Token：`.planning/ui-spec/colors.json`
- 组件库：`packages/web-ui/src/components/design-system/`

## 实现细节

### 颜色系统
```typescript
// src/styles/colors.ts
export const colors = {
  primary: {
    50: '#f0f7ff',
    100: '#e0f1fe',
    500: '#0084ff',   // 主蓝
    900: '#003d82',
  },
  neutral: {
    0: '#ffffff',
    50: '#f9fafb',
    900: '#111827',
  },
  semantic: {
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
  }
};
````

### 响应式工具

```typescript
// src/hooks/useResponsive.ts
export const useResponsive = () => {
  const isMobile = useMediaQuery('(max-width: 640px)');
  const isTablet = useMediaQuery('(max-width: 1024px)');
  const isDesktop = useMediaQuery('(min-width: 1025px)');
  return { isMobile, isTablet, isDesktop };
};

// 用法
const { isMobile } = useResponsive();
return isMobile ? <MobileLayout /> : <DesktopLayout />;
```

### 动画库

```typescript
// src/animations/transitions.ts
export const fadeIn = {
	initial: { opacity: 0 },
	animate: { opacity: 1 },
	transition: { duration: 0.2 },
}

export const slideUp = {
	initial: { y: 20, opacity: 0 },
	animate: { y: 0, opacity: 1 },
	transition: { duration: 0.3 },
}
```

## 验收标准

1. ✓ 所有 6 维度通过 UI-REVIEW 检查
2. ✓ Figma 设计与实现 100% 对齐
3. ✓ Lighthouse Accessibility 评分 > 90
4. ✓ 暗黑模式完全适配
5. ✓ 移动端、平板、桌面均通过 Playwright 视觉回归测试
6. ✓ 性能：首屏 < 2s，后续交互 < 300ms
7. ✓ 无 TypeScript 类型错误、Linter 通过
8. ✓ Code Review 通过、无 a11y 警告

````

---

### UI-REVIEW 维度

执行 `gsd ui-review` 后，会生成 UI-REVIEW.md，评分如下：

| 维度 | 评分标准 | 示例 |
|------|----------|------|
| **Usability** | LOW/MEDIUM/HIGH | 首屏操作 5 个以内 ✓ |
| **Accessibility** | WCAG A / AA / AAA | WCAG AA ✓ |
| **Responsive** | 通过 3 断点测试 | 320/768/1920 都可用 ✓ |
| **Dark Mode** | 对比度检查 | 所有文本 > 4.5:1 ✓ |
| **Motion** | 性能 + 可访问性 | 60fps + 支持 prefers-reduced-motion ✓ |
| **Consistency** | 色板、排版、间距一致 | 使用全局 Token ✓ |

**最终**: 6/6 维度通过 = PASS，可发布

---

### 快速启动 UI 项目

```bash
# Step 1: 讨论
gsd discuss-phase --context "聊天 UI 重设计"

# Step 2: 设计规范
gsd ui-phase

# Step 3: 规划
gsd plan-phase

# Step 4: 开发
gsd execute-phase

# Step 5: 视觉审计
gsd ui-review

# Step 6: 验证
gsd verify-work

# Step 7: 发布
gsd ship
````

---

## 总结对比

| 场景         | 难度       | 周期 | 关键产物           | 风险           |
| ------------ | ---------- | ---- | ------------------ | -------------- |
| **新项目**   | ⭐⭐⭐⭐⭐ | 4-6w | PROJECT + 代码     | 需求漂移       |
| **维护调试** | ⭐⭐       | 1-2d | 修复 + 测试        | 引入新 bug     |
| **AI 系统**  | ⭐⭐⭐⭐   | 4-8w | AI-SPEC + 评估     | 幻觉、成本爆炸 |
| **UI/UX**    | ⭐⭐⭐     | 2-4w | UI-SPEC + 设计代码 | 体验割裂       |
