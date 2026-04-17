# wzxClaw 评测系统使用指南

## 概述

wzxClaw 评测系统提供了一套完整的 **"评测 → 分析 → 修复 → 再评测"** 闭环工具链，帮助量化 coding agent 能力并驱动迭代改进。

### 架构

```
Langfuse 数据集 (Aider / SWE-bench)  →  Headless Runner (AgentLoop)
       ↓
三层评分 (A: 测试执行 + B: 自动指标 + C: LLM Judge)
       ↓
弱点分析 → 报告生成 → 修复 → 再评测
```

### 三层评分体系

| 层级 | 方式 | 评分项 |
|------|------|--------|
| **A** | 运行 `testCommand` | `test_passed` (0/1) — 客观判定 |
| **B** | EvalCollector 自动采集 | `tool_success_rate`, `turns_used`, `edit_success_rate` 等 11 项 |
| **C** | LLM-as-Judge | `task_completion`, `code_quality`, `efficiency`, `error_handling` (1-5) |

### 数据隔离

评测数据和生产数据使用**独立的 Langfuse 项目**：

| 项目 | 用途 | Key |
|------|------|-----|
| `wzxclaw` (原项目) | 生产 trace | `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` |
| `wzxclaw-eval` (新项目) | 评测数据 | `LANGFUSE_EVAL_PUBLIC_KEY` / `LANGFUSE_EVAL_SECRET_KEY` |

`eval-bootstrap.ts` 在启动时自动切换到评测项目，不影响生产 trace。

---

## 快速开始

### 前置条件

`.env` 文件需包含：

```
# 智谱 GLM API（Anthropic 兼容接口）
ANTHROPIC_API_KEY=your-key
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic

# Langfuse（生产）
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=http://192.168.100.78:3000

# Langfuse（评测专用项目 wzxclaw-eval）
LANGFUSE_EVAL_PUBLIC_KEY=pk-lf-...
LANGFUSE_EVAL_SECRET_KEY=sk-lf-...
```

### 第 1 步：导入数据集到 Langfuse

```bash
npm run eval:import
```

推送两个数据集到 wzxclaw-eval 项目：
- `aider-polyglot-regression` — 10 道代码编辑题
- `swebench-verified-curated` — 5 道 bug 修复题

导入后可在 Langfuse UI 的 **wzxclaw-eval** 项目 Datasets 页面查看。

### 第 2 步：建立基线

首次评测的结果就是**基线**，后续迭代都跟它对比：

```bash
# Aider 回归基线
npx tsx scripts/eval/eval-bootstrap.ts run --dataset=aider-polyglot --model=glm-5.1 --run-name="baseline-aider-v1"

# SWE-bench 能力基线
npx tsx scripts/eval/eval-bootstrap.ts run --dataset=swebench-curated --model=glm-5.1 --run-name="baseline-swebench-v1"
```

### 第 3 步：查看报告

```bash
# 生成摘要 + 弱点分析报告
npm run eval:report -- --run-name="baseline-aider-v1"

# 仅分析弱点
npm run eval:analyze -- --run-name="baseline-aider-v1"
```

### 第 4 步：迭代

```bash
# 修改代码/prompt 后跑新评测
npx tsx scripts/eval/eval-bootstrap.ts run --dataset=aider-polyglot --model=glm-5.1 --run-name="v2-prompt-fix"

# 对比基线 vs 新版
npm run eval:compare -- --run-a="baseline-aider-v1" --run-b="v2-prompt-fix"
```

报告文件保存在 `.eval-reports/` 目录。

---

## 命令参考

> **注意**：所有 `npx tsx` 命令入口都是 `scripts/eval/eval-bootstrap.ts`（不是 `eval-cli.ts`）

| 命令 | 说明 |
|------|------|
| `npm run eval:import` | 导入数据集到 Langfuse |
| `npm run eval:run -- [options]` | 运行评测 |
| `npm run eval:report -- --run-name=X` | 生成报告 |
| `npm run eval:analyze -- --run-name=X` | 弱点分析 |
| `npm run eval:compare -- --run-a=X --run-b=Y` | 对比两次运行 |
| `npm run eval:regression` | 快捷回归（Aider 全部 + glm-5.1） |

### run 命令参数

支持 `--key=value` 和 `--key value` 两种格式。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--dataset` | `aider-polyglot` | `aider-polyglot` 或 `swebench-curated` |
| `--model` | `glm-5.1` | 被评测的模型 |
| `--provider` | 自动检测 | `openai` 或 `anthropic` |
| `--max-turns` | 15 | 每个任务最大轮次 |
| `--limit` | 0 (全部) | 只跑前 N 条（快速验证用） |
| `--run-name` | 自动生成 | 运行名称（基线/对比的关键） |
| `--judge-model` | `glm-4-flash` | Judge 评估用的模型（省钱） |
| `--keep` | false | 保留工作空间（调试用） |

---

## 数据集

### Aider Polyglot 回归集 (10 题)

| ID | 语言 | 难度 | 类型 | 任务 |
|----|------|------|------|------|
| aider-pg-001 | Python | easy | 实现 | 回文判断 `is_palindrome()` |
| aider-pg-002 | Python | easy | 实现 | 列表扁平化 `flatten()` |
| aider-pg-003 | Python | easy | 实现 | 词频统计 `count_words()` |
| aider-pg-004 | Python | medium | 数据结构 | LRU Cache O(1) |
| aider-pg-005 | Python | medium | 算法 | 区间合并 `merge_intervals()` |
| aider-pg-006 | JavaScript | easy | 实现 | `groupBy()` 数组分组 |
| aider-pg-007 | Python | medium | 算法 | Top-K 频繁元素 |
| aider-pg-008 | Python | medium | Bug修复 | Calculator 除零+表达式解析 |
| aider-pg-009 | Python | hard | 数据结构 | 二叉搜索树 insert/search/delete |
| aider-pg-010 | Python | easy | 实现 | 罗马数字转整数 |

### SWE-bench Verified 精选集 (5 题)

| ID | 难度 | 类型 | 任务 |
|----|------|------|------|
| swebench-001 | medium | Bug修复 | URL 验证器 userinfo 正则 |
| swebench-002 | hard | Bug修复 | 二分查找 off-by-one |
| swebench-003 | medium | 并发 | 线程安全计数器竞态条件 |
| swebench-004 | easy | Bug修复 | JSON 解析器嵌套+转义 |
| swebench-005 | medium | Bug修复 | CSV 字段逗号/引号/换行转义 |

### 添加自定义题目

编辑 `data/eval/aider-polyglot-curated.json`：

```json
{
  "id": "custom-001",
  "source": "aider-polyglot",
  "language": "python",
  "difficulty": "easy",
  "description": "实现函数 foo...",
  "startingFiles": {
    "foo.py": "def foo():\n    pass\n",
    "test_foo.py": "from foo import foo\ndef test_foo():\n    assert foo() == 42\n"
  },
  "testCommand": "cd $WORKSPACE && python -m pytest test_foo.py -v",
  "metadata": { "category": "implementation" }
}
```

然后重新 `npm run eval:import`。

---

## 弱点分析规则

| 规则 | 检测条件 | 修复建议 |
|------|----------|----------|
| 测试失败率高 | fail rate > 50% | system prompt 加测试引导 |
| 平均轮次过多 | avg turns > 10 | prompt 加"先想后做"引导 |
| 简单题失败多 | easy fail rate > 30% | 检查工具执行是否正常 |
| 特定语言弱 | 某语言 fail rate > 50% | 加语言专项 prompt |
| 运行时错误 | crash | 检查 API 限流、工具异常 |
| 效率评分低 | judge efficiency < 3 | 减少不必要工具调用 |

---

## 模型定价

| 模型 | 输入 ($/1M tokens) | 输出 ($/1M tokens) |
|------|-------------------|-------------------|
| **glm-5.1** | $0.82 (¥6) | $3.29 (¥24) |
| glm-5-turbo | $1.20 | $4.00 |
| glm-5 | $1.00 | $3.20 |
| glm-4-flash (judge 用) | $0.01 | $0.01 |

> 来源：[bigmodel.cn/pricing](https://bigmodel.cn/pricing) / [docs.z.ai](https://docs.z.ai/guides/overview/pricing)

---

## 文件结构

```
scripts/eval/
  eval-bootstrap.ts        # CLI 入口（切换 Langfuse 项目后加载 impl）
  eval-cli-impl.ts         # CLI 实现（命令解析 + 调度）
  import-datasets.ts       # 数据集导入
  prepare-swebench.ts      # SWE-bench 数据准备说明

src/eval/
  types.ts                 # 共享类型
  headless-runner.ts       # Headless AgentLoop 运行器
  workspace-isolation.ts   # 工作空间隔离
  batch-runner.ts          # 批量执行
  scorer.ts                # 多层评分
  score-aggregator.ts      # 评分聚合
  weakness-analyzer.ts     # 弱点分析
  report-generator.ts      # 报告生成
  comparison-report.ts     # 前后对比

data/eval/
  aider-polyglot-curated.json    # Aider 回归题 (10 题)
  swebench-verified-curated.json # SWE-bench 精选题 (5 题)

.eval-reports/                   # 生成的报告 (gitignore)
.eval-workspaces/                # 临时工作空间 (gitignore)
```

---

## 完整 SWE-bench 集成（进阶）

当前 SWE-bench 精选集是独立可运行的简化题。要接入完整 SWE-bench Verified (500 条)：

```bash
# 1. 下载（Python）
pip install datasets
python -c "
from datasets import load_dataset; import json
ds = load_dataset('princeton-nlp/SWE-bench_Verified', split='test')
items = [{'id': f'swebench-{i:03d}', ...} for i, x in enumerate(ds)]
json.dump(items, open('data/eval/swebench-full.json', 'w'), indent=2)
"

# 2. SWE-bench harness 评分（需要 Docker + 120GB 磁盘）
pip install swebench
python -m swebench.harness.run_evaluation \
  --predictions_path .eval-reports/predictions.jsonl \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --max_workers 4
```

注意：SWE-bench harness 是独立于 Langfuse 的，通过 Docker 运行真实测试用例判定 patch 是否正确。
