# GSD Skills 使用指南

## 核心工作流

### 项目启动

- **`gsd new-project`** — 初始化新项目，创建 PROJECT.md + ROADMAP.md
- **`gsd new-milestone`** — 开始新一轮迭代，更新版本号

### 阶段管理

- **`gsd discuss-phase`** — 通过 Socratic 提问梳理阶段背景（推荐首步）
- **`gsd spec-phase`** — 澄清 WHAT（输出 SPEC.md，评估歧义）
- **`gsd plan-phase`** — 详细规划 HOW（输出 PLAN.md，验证可行性）
- **`gsd execute-phase`** — 执行所有 plan 任务，波形并行处理
- **`gsd verify-work`** — UAT 验证，确认交付物符合承诺

### 代码质量

- **`gsd code-review`** — 扫描源代码找 bug、安全、性能问题（输出 REVIEW.md）
- **`gsd debug`** — 系统化调试，保存检查点，支持上下文恢复
- **`gsd secure-phase`** — 回溯验证威胁缓解（输出 SECURITY.md）
- **`gsd validate-phase`** — 填充 Nyquist 验证缺口（输出验证报告）

### 特定类型的阶段

- **`gsd ai-integration-phase`** — AI 系统设计合同（输出 AI-SPEC.md，含框架选型、评估策略）
- **`gsd ui-phase`** — 前端设计规范（输出 UI-SPEC.md，6 个质量维度）

### 上下文与知识

- **`gsd map-codebase`** — 并行探索器分析代码，生成 .planning/codebase/ 文档
- **`gsd docs-update`** — 生成或更新项目文档，验证对齐
- **`gsd extract-learnings`** — 从阶段产物提取决策、模式、教训

### 交付与发布

- **`gsd ship`** — 创建 PR + 运行审查 + 准备合并
- **`gsd pr-branch`** — 清理 PR 分支（过滤掉 .planning/ 提交）
- **`gsd complete-milestone`** — 归档已完成的 milestone，准备下一版本

## 快速命令

### 规划

```bash
gsd progress              # 检查进度，推进工作流
gsd phase --add           # 向 ROADMAP 添加新阶段
gsd import                # 导入外部计划，检查冲突
```

### 执行

```bash
gsd quick [task]          # 快速任务（跳过可选代理）
gsd fast [task]           # 极轻量任务（无规划开销）
gsd pause-work            # 暂停工作，保存上下文
gsd resume-work           # 从上次会话恢复（完整上下文）
```

### 审查与质量

```bash
gsd audit-uat             # 跨阶段审查所有未完成的 UAT
gsd audit-milestone       # 阶段完成前审计（对标初衷）
gsd eval-review           # AI 阶段评估覆盖审计
gsd ui-review             # 前端代码 6 维度视觉审计
```

### 管理

```bash
gsd workstreams           # 管理并行工作流（列表、创建、切换、状态）
gsd thread                # 管理跨会话持久上下文
gsd health                # 诊断 .planning/ 目录健康状态
gsd cleanup               # 从已完成 milestone 归档阶段目录
```

## 高级技巧

### 多人协作

- **`gsd review`** — 请求外部 AI 对阶段计划的对等审查
- **`gsd plan-review-convergence`** — 反复规划 + 审查直到无 HIGH 疑虑

### 可视化与分析

- **`gsd graphify`** — 构建项目知识图（查询、检查、可视化）
- **`gsd stats`** — 项目统计（阶段数、计划数、需求数、git 指标、时间线）
- **`gsd milestone-summary`** — 为团队生成综合总结（onboarding 友好）

### 架构设计

- **`gsd ingest-docs`** — 从现有 ADR/PRD/SPEC 启动 .planning/ 结构
- **`gsd graphify`** + **`gsd map-codebase`** — 理解大型遗留项目

### 配置与工具

- **`gsd config`** — 工作流开关、高级旋钮、集成、模型配置
- **`gsd settings`** — 配置工作流开关与模型配置
- **`gsd update`** — 升级到最新 GSD 版本

## 常见场景

### 场景 1：从零开始新项目

```bash
gsd new-project              # 初始化
gsd discuss-phase            # 梳理需求
gsd plan-phase               # 详细规划
gsd execute-phase            # 落地实现
gsd verify-work              # UAT 验证
gsd ship                      # 提交 PR
gsd complete-milestone       # 完成 M1，准备 M2
```

### 场景 2：维护 + 调试现有项目

```bash
gsd code-review              # 扫描质量问题
gsd debug                    # 定位 bug
gsd verify-work              # 验证修复
gsd ship                      # 发布
```

### 场景 3：AI 系统设计（如新的 Agent Loop 或 LLM 集成）

```bash
gsd discuss-phase            # 需求澄清
gsd ai-integration-phase     # 设计 AI-SPEC（框架选型、评估策略、监控）
gsd plan-phase               # 详细规划
gsd execute-phase            # 实现
gsd eval-review              # 审计评估覆盖
gsd verify-work              # 端到端验证
gsd secure-phase             # 安全检查
gsd ship                      # 发布
```

### 场景 4：UI/UX 工作

```bash
gsd ui-phase                 # 生成 UI-SPEC（设计规范）
gsd plan-phase               # 前端规划
gsd execute-phase            # 开发
gsd ui-review                # 6 维度视觉审计
gsd ship                      # 发布
```

### 场景 5：多人并行工作

```bash
gsd workstreams --create     # 为每个子团队创建工作流
gsd workstreams --switch     # 切换活跃工作流
gsd thread                   # 跨工作流共享上下文
gsd review                   # 请求对等 AI 审查计划
```

## 关键文件输出

| Skill                  | 输出                   | 用途              |
| ---------------------- | ---------------------- | ----------------- |
| `new-project`          | PROJECT.md, ROADMAP.md | 项目愿景 + 路线图 |
| `discuss-phase`        | 会话记录 + 背景文档    | 前期梳理          |
| `spec-phase`           | SPEC.md                | 需求 + 歧义评分   |
| `plan-phase`           | PLAN.md                | 任务、依赖、估时  |
| `execute-phase`        | 代码提交 + 任务检查点  | 实现记录          |
| `code-review`          | REVIEW.md              | 代码质量报告      |
| `debug`                | 检查点 + FIXES         | 调试历史          |
| `ai-integration-phase` | AI-SPEC.md             | AI 系统设计       |
| `ui-phase`             | UI-SPEC.md             | UI 设计规范       |
| `secure-phase`         | SECURITY.md            | 安全验证          |
| `eval-review`          | EVAL-REVIEW.md         | 评估覆盖审计      |
| `ui-review`            | UI-REVIEW.md           | 视觉审计报告      |

## 命令格式

大多数 skill 可通过 Copilot 对话调用：

```
@copilot /gsd-[skillname] [context]
```

或通过终端（如果有 GSD CLI）：

```bash
gsd [skillname] [options]
```

## 最佳实践

1. **阶段工作流优先级**：discuss → spec → plan → execute → verify
2. **质量网关**：每个 execute 后必做 code-review + verify-work
3. **架构设计**：AI/UI 工作优先做 spec-phase + 专用设计工具（ai-integration-phase / ui-phase）
4. **大项目**：先 map-codebase + 审查现有架构，再规划新工作
5. **多人团队**：用 workstreams 隔离工作，用 thread 共享关键上下文
6. **发布前**：secure-phase + audit-uat + ship 三步连贯

---

**提示**：大多数 skill 支持 `--help` 或 `-h` 获取完整选项列表。
