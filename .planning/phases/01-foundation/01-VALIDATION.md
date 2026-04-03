---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-03
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vitest.config.ts` (at project root) |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --coverage` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | LLM-05, LLM-06 | unit | `npx vitest run src/main/llm/__tests__/gateway.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-02 | 01 | 1 | LLM-01, LLM-05 | unit | `npx vitest run src/main/llm/__tests__/openai-adapter.test.ts` | ❌ W0 | ⬜ pending |
| 01-01-03 | 01 | 1 | LLM-02, LLM-05 | unit | `npx vitest run src/main/llm/__tests__/anthropic-adapter.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-01 | 02 | 1 | ELEC-02 | unit | `npx vitest run src/shared/__tests__/ipc-channels.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-02 | 02 | 1 | ELEC-02 | unit | `npx vitest run src/preload/__tests__/preload.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-01 | 03 | 2 | LLM-01,LLM-02,LLM-05,LLM-06,ELEC-02 | build | `npx electron-vite build` | ❌ W0 | ⬜ pending |
| 01-03-02 | 03 | 2 | All | smoke | `npm run dev` (manual startup verify) | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.ts` — vitest configuration with TypeScript support
- [ ] `src/main/llm/__tests__/gateway.test.ts` — stubs for LLM Gateway tests
- [ ] `src/main/llm/__tests__/openai-adapter.test.ts` — stubs for OpenAI adapter tests
- [ ] `src/main/llm/__tests__/anthropic-adapter.test.ts` — stubs for Anthropic adapter tests
- [ ] `src/shared/__tests__/ipc-channels.test.ts` — stubs for IPC channel type tests
- [ ] `src/preload/__tests__/preload.test.ts` — stubs for preload validation tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| electron-vite dev server starts | ELEC-02 | Requires running Electron app | Run `npm run dev`, verify window opens |
| IPC messages round-trip between processes | ELEC-02 | Requires running Electron with both processes | Send message from renderer, verify receipt in main process log |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
