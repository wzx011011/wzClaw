# 魏志晓 · 个人简历

**求职意向：** AI Agent 应用开发工程师 / AI Coding IDE 工程师 / AI 自动化工程师

---

|                                           |                            |
| ----------------------------------------- | -------------------------- |
| **姓名：** 魏志晓                         | **性别：** 男              |
| **出生：** 1990.08                        | **现居：** 深圳            |
| **电话：** 13249430153                    | **邮箱：** wzx0081@163.com |
| **GitHub：** https://github.com/wzx011011 |                            |

---

## 个人简介

多年大型桌面端研发经验，近一年专注 **AI Agent、AI Coding IDE、LLM 工程化、AI 自动化测试** 全链路落地。具备从 0→1 设计与实现 Agent Runtime、多模型网关、MCP 扩展、RAG 检索、多 Agent 协作、闭环自动化的完整工程能力。技术栈覆盖 C++/Qt、Electron/React/Node.js、Python/FastAPI、Flutter，擅长将大模型能力与业务流程深度结合，输出可规模化、可观测、可复用的 AI 应用体系。

---

## 核心技能

### AI Agent / LLM 工程

- **Agent 体系：** Agent Loop、多轮工具调用、上下文压缩、Memory、权限审批、MCP/Skills 扩展
- **模型集成：** OpenAI、DeepSeek、GLM、Anthropic 兼容封装、Function Calling、多模型网关
- **RAG 体系：** ChromaDB、Hybrid Retriever、语义检索、历史知识沉淀、规则知识库
- **工程能力：** 流式输出、断点恢复、幂等、流程编排、审批门禁、自动化闭环

### 全栈开发

- **客户端：** C++17/20、Qt Widgets/QML、wxWidgets、Electron、React、Zustand、Monaco Editor
- **服务端：** Python、FastAPI、异步 SQLAlchemy、pytest-asyncio、WebSocket Relay
- **移动端：** Flutter、远程控制、跨端互通
- **工程化：** Docker、GitHub Actions、CI/CD、Gerrit、Git、CMake、vcpkg

### AI 自动化与测试

- **UI 自动化：** C++ 状态导出、Python Skill Runner、事件驱动等待、路径规划
- **AI 测试：** 意图路由、失败恢复、执行轨迹、结构化验收、截图回溯、回放分析

---

## 工作经历

### 创想三维（Creality） | C++ UI/UX 开发工程师

**2021.06 – 至今**

- 负责 C3DSlicer / CrealityPrint 切片软件核心 UI 架构与跨平台开发，累计提交 1500+，主导多版本迭代与国际化
- 主导搭建 **AI 驱动 UI 自动化测试 Agent 体系**，设计 C++ 状态导出、Skill 编排、意图路由与路径规划，将传统脚本升级为可复用、可恢复的自动化架构，显著提升回归效率与稳定性
- 完成高 DPI 适配、主题系统、新手引导、参数配置、WiFi 传输、OTA 升级等核心模块
- 支撑 Windows/macOS/Linux 多平台，完成 10+ 语言国际化与品牌定制版本交付

### 正链科技深圳有限公司 | C++ 开发工程师

**2019.04 – 2021.05**

- Qt 跨平台链上电商平台开发，插件化架构、热更新、JSON-RPC/Protobuf 通信、SQLite 数据层
- 实现 KV 映射关系型存储、统一 Model 与 QML 绑定，支撑 Windows/Linux/Android 三平台

### 深圳市漠野软件有限公司 | C++ 开发工程师

**2016.11 – 2018.12**

- 个人云共享软件、iOS 设备管理工具 PC 端全界面开发，MVC、QSS、多线程、跨平台移植

### 华为项目 LMT 版本组 | C++ 开发工程师

**2014.10 – 2016.05**

- 电信设备问题定位、补丁开发、版本发布、业务迁移工具实现

---

## AI 相关项目经验

### 1. wzxClaw — AI Coding IDE / Agent Runtime（自研）

**2026.04 – 至今**

负责全栈架构设计与核心实现，打造本地可控、可远程、可扩展的 AI 编程 IDE。

- 设计并实现 **Agent Runtime**：AsyncGenerator 多轮循环、流式输出、工具调用、上下文自动压缩、会话状态管理
- 构建**多模型统一网关**，兼容 OpenAI/Anthropic 接口，支持 DeepSeek/Claude/GLM/GPT 切换
- 实现 **17 类标准化工具**：文件读写、grep/glob、Bash、WebSearch、SemanticSearch、GoToDefinition 等
- 设计**权限控制系统**（always-ask/plan/accept-edits/bypass），降低自动化执行风险
- 支持 **MCP 扩展、Skill 插件、持久化 Memory、RAG 索引**，实现跨会话知识加载
- **技术栈：** Electron、React、Node.js、Flutter、WebSocket Relay、Docker、CI/CD

### 2. CodeReview Agent — AI 代码评审与流程编排系统（自研）

**2026.05 – 至今**

设计 AI 代码评审全流程体系，集成 Gerrit、禅道、LLM、RAG 与流程编排。

- 实现 ReviewAgent、上下文扩展、误报过滤、结构化评审、结果输出
- 搭建 **Pipeline Orchestrator**，支持幂等、断点恢复、审批门禁、阶段统计
- 基于 **ChromaDB + Hybrid Retriever** 构建历史评审知识库，提供规范与缺陷模式检索
- **技术栈：** FastAPI、SQLAlchemy async、React、Vite、TailwindCSS、pytest-asyncio

### 3. AI 驱动 UI 自动化测试 Agent（企业项目）

**2026.01 – 2026.03**

面向切片软件构建意图驱动 UI 自动化 Agent，替代固定脚本。

- 设计 **C++ 状态导出机制**，将界面与业务状态输出为结构化 JSON 供 AI 调用
- 实现 Skill Runner、意图路由、路径规划、状态机、失败恢复
- 输出执行报告、截图回溯、轨迹回放，支持 AI 自主决策与验收
- 大幅提升回归覆盖、稳定性与可维护性

### 4. ACT — C++20/Qt6 原生 AI Coding Tool（自研）

**2026.03 – 至今**

- C++ 原生高性能 AI 编程工具，Headless CLI、任务持久化、跨会话恢复
- 实现需求分解、拓扑排序、构建验证、无监督迭代自动化闭环

### 5. 多 Agent 交付体系（自研）

**2026.03 – 至今**

- 设计 PM→Dev→Review→Test 多角色 Agent 协作流程
- 实现项目记忆、状态持久化、Skills 标准化、多 AI Coding 工具适配

---

## 教育背景

**河南城建学院** | 信息管理与信息系统 | 本科
**2009.09 – 2013.06**

---

## 自我评价

- 兼具**多年客户端底层功底**与 **AI Agent 全栈工程化能力**，能独立负责从 0→1 落地 AI 产品
- 深入了解 Agent Runtime、工具系统、MCP、RAG、多模型网关、自动化闭环
- 技术栈全面、工程规范严谨，具备大厂级架构设计、质量保障、可观测性、交付效率意识
- 学习与落地能力突出，擅长将前沿大模型应用快速转化为业务价值
