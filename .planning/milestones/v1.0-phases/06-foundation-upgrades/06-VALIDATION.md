---
phase: 6
slug: foundation-upgrades
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-08
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.x |
| **Config file** | vitest.config.ts (project root) |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | PERSIST-01 | T-06-01 | Session files stored under userData, not project dir | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "append"` | Wave 0 | pending |
| 06-01-02 | 01 | 1 | PERSIST-02 | — | N/A | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "auto-save"` | Wave 0 | pending |
| 06-01-03 | 01 | 1 | PERSIST-03 | — | N/A | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "load"` | Wave 0 | pending |
| 06-01-04 | 01 | 1 | PERSIST-04 | — | N/A | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "restore"` | Wave 0 | pending |
| 06-01-05 | 01 | 1 | PERSIST-05 | — | N/A | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "corruption"` | Wave 0 | pending |
| 06-01-06 | 01 | 1 | PERSIST-06 | T-06-02 | Project hash uses SHA-256, not reversible | unit | `npx vitest run src/main/persistence/__tests__/session-store.test.ts -t "project-hash"` | Wave 0 | pending |
| 06-02-01 | 02 | 1 | CTX-02 | — | N/A | unit | `npx vitest run src/main/context/__tests__/token-counter.test.ts` | Wave 0 | pending |
| 06-02-02 | 02 | 1 | CTX-01, CTX-03 | — | N/A | unit | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "usage"` | Wave 0 | pending |
| 06-02-03 | 02 | 1 | CTX-04 | — | N/A | unit | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "circuit breaker"` | Wave 0 | pending |
| 06-02-04 | 02 | 2 | CTX-05, CTX-06 | — | N/A | integration | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "manual compact"` | Wave 0 | pending |
| 06-02-05 | 02 | 2 | CTX-07 | — | N/A | unit | `npx vitest run src/main/context/__tests__/context-manager.test.ts -t "truncation"` | Wave 0 | pending |
| 06-03-01 | 03 | 2 | CMD-02 | — | N/A | unit | `npx vitest run src/renderer/stores/__tests__/command-store.test.ts` | Wave 0 | pending |
| 06-03-02 | 03 | 2 | CMD-03 | — | N/A | unit | `npx vitest run src/renderer/stores/__tests__/command-store.test.ts -t "built-in"` | Wave 0 | pending |
| 06-03-03 | 03 | 2 | CMD-05 | — | N/A | unit | `npx vitest run src/renderer/stores/__tests__/command-store.test.ts -t "plugin"` | Wave 0 | pending |
| 06-03-04 | 03 | 2 | CMD-01 | — | N/A | manual-only | N/A | N/A | pending |
| 06-03-05 | 03 | 2 | CMD-04 | — | N/A | manual-only | N/A | N/A | pending |

*Status: pending = not yet run*

---

## Wave 0 Requirements

- [ ] `src/main/persistence/__tests__/session-store.test.ts` — covers PERSIST-01 through PERSIST-06
- [ ] `src/main/context/__tests__/token-counter.test.ts` — covers CTX-02
- [ ] `src/main/context/__tests__/context-manager.test.ts` — covers CTX-01, CTX-03, CTX-04, CTX-05, CTX-06, CTX-07
- [ ] `src/renderer/stores/__tests__/command-store.test.ts` — covers CMD-02, CMD-03, CMD-05

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Ctrl+Shift+P opens command palette | CMD-01 | Renderer keyboard event, requires running Electron app | Launch app, press Ctrl+Shift+P, verify overlay appears |
| Keyboard shortcuts displayed next to command names | CMD-04 | Visual rendering check | Open command palette, verify shortcut text visible beside each command |
| Token usage indicator updates in chat panel | CTX-01 | Requires full agent turn to complete | Send message, verify token count updates in chat panel |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
