# Desktop UI Performance Baseline

## 目的

桌面端 UI 反馈有卡顿。为防止后续新功能继续恶化体验，建立可量化的基线，并在每次添加可能影响 UI 的功能后做对照。

## 测量维度

| 指标                  | 描述                                      | 退化阈值           |
| --------------------- | ----------------------------------------- | ------------------ |
| `coldStartMs`         | 启动到 `.chat-panel` 可见                 | +20% 失败          |
| `idleHeapMb`          | 启动 5s 后 JS 堆占用                      | +25% 失败          |
| `inputLatencyMs`      | chat 输入回显中位数                       | +30% 失败          |
| `streamDroppedFrames` | 模拟 500 个 token delta 期间 >32ms 的帧数 | +50% 失败          |
| `streamAvgFrameMs`    | 同上的平均帧间隔（参考值）                | —                  |
| `scrollFps`           | 长列表滚动 1.5s 的平均 FPS                | 低于基线 −15% 失败 |
| `tabSwitchMs`         | chat ↔ ide 切换中位数                     | +25% 失败          |
| `longTaskMs`          | 测量全程 `longtask`（>50ms）累计          | +30% 失败          |

阈值定义见 [test/perf/baseline.spec.ts](test/perf/baseline.spec.ts) 中的 `REGRESSION_THRESHOLDS`。

## 使用方式

### 1. 首次建立基线

```powershell
cd wzxClaw_desktop
npm run build:win          # 必须先打包，perf 测试跑的是 dist/win-unpacked/wzxClaw.exe
npm run perf:baseline
```

完成后会写出：

- `test/perf/baseline.json` — 后续对比的基线，**应提交到 git**
- `test/perf/results/<timestamp>.json` — 本次原始数据

### 2. 添加新功能后对比

```powershell
npm run build:win
npm run perf:compare
```

任一指标退化超过阈值即测试失败，错误信息会列出退化的项与百分比。

### 3. 显式刷新基线

确认新基线（例如经评审接受了某项功能带来的合理开销）后：

```powershell
Remove-Item test/perf/baseline.json
npm run perf:baseline
git add test/perf/baseline.json
git commit -m "perf: rebaseline after <feature>"
```

## 工作流

每个新功能 PR 必须：

1. 在主分支基础上跑 `perf:compare`，记录差异；
2. 若退化超阈值，必须有优化措施或在 PR 说明里给出合理性论据并显式刷新基线；
3. 优先在以下高风险变更点使用基线对比：
   - chat 消息列表 / 流式渲染相关
   - Monaco / 文件树 / 终端
   - 新增全局 store 或重型组件（CommandPalette、Settings、Host 管理等）

## 当前已知卡顿可疑点（待优化清单）

- `packages/web-ui/src/components/chat/MessageList.tsx` — 没有虚拟化，长会话会重渲染所有消息
- chat streaming：每个 token delta 都触发 `chat-store` 更新 → 列表全量重排
- Monaco 编辑器初次加载较重
- Allotment 拖拽期间布局抖动
- 多 Zustand store 订阅（无 selector 切片）

建立基线后这些点会成为优化目标，每次优化都用 `perf:compare` 验收。
