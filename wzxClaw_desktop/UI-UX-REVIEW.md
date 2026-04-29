---
phase: ui-ux-optimization-phases-a-d
reviewed: 2026-04-26T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - src/renderer/App.tsx
  - src/renderer/components/chat/AskUserQuestion.tsx
  - src/renderer/components/chat/ChatMessage.tsx
  - src/renderer/components/chat/ChatPanel.tsx
  - src/renderer/components/chat/SettingsModal.tsx
  - src/renderer/components/chat/ToolCard.tsx
  - src/renderer/components/ide/EditorPanel.tsx
  - src/renderer/components/ide/MobileConnectModal.tsx
  - src/renderer/components/ide/PreviewPanel.tsx
  - src/renderer/components/ide/StatusBar.tsx
  - src/renderer/components/tasks/TaskCard.tsx
  - src/renderer/components/tasks/TaskHomePage.tsx
  - src/renderer/components/Toast.tsx
  - src/renderer/stores/toast-store.ts
  - src/renderer/styles/chat.css
  - src/renderer/styles/ide.css
  - src/renderer/styles/tasks.css
findings:
  critical: 0
  warning: 5
  info: 5
  total: 10
status: issues_found
---

# UI/UX Optimization (Phases A–D): Code Review Report

**Reviewed:** 2026-04-26
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Reviewed all 17 renderer source files covering the four-phase UI/UX optimization (CSS variable migration, keyboard accessibility, Toast system, Chinese copy). The Toast store implementation is correct and clean — no memory leaks or race conditions. Keyboard accessibility patterns (`role="button"` + `tabIndex={0}` + `onKeyDown`) are correctly applied in most places.

Five warnings found: two CSS variable name typos that silently break hover/text-color styles, one keyboard event-bubbling bug where inner action buttons unexpectedly trigger card navigation, one silent error catch that Phase C missed, and one semantic misuse of `<a href="#">` for non-navigation actions. Five info-level items cover missing ARIA dialog role, a stale timer on unmount, debug log statements, an undefined CSS fallback variable, and a TypeScript `as any` cast.

---

## Warnings

### WR-01: Inner action buttons bubble keyboard events through to TaskCard's `onKeyDown`

**File:** `src/renderer/components/tasks/TaskCard.tsx:48-52`

**Issue:** The outer `div[role="button"]` handles `onKeyDown` to call `onOpen(task.id)`. The inner `.task-card-actions` div suppresses `onClick` propagation (`e.stopPropagation()`), but does **not** suppress `onKeyDown`. When a keyboard user tabs to an inner action button (rename ✎, archive 📦, delete ✕) and presses Enter or Space, two things happen simultaneously:

1. The native button's click fires (correct).
2. The keyboard event bubbles to the outer div's `onKeyDown`, which also calls `onOpen(task.id)`.

This causes the task to open unexpectedly every time an action button is activated via keyboard.

**Fix:**

```tsx
// Add onKeyDown stopPropagation to task-card-actions:
<div
  className="task-card-actions"
  onClick={(e) => e.stopPropagation()}
  onKeyDown={(e) => e.stopPropagation()}   // ← add this line
>
```

---

### WR-02: Undefined CSS variable `--bg-hover` (should be `--hover-bg`)

**File:** `src/renderer/styles/ide.css:210, 268`

**Issue:** `:root` defines `--hover-bg: #2a2a2a` but two selectors reference the non-existent `var(--bg-hover)`. When the variable is undefined, CSS falls back to the browser default (transparent), making hover backgrounds invisible on titlebar buttons and the preview panel action button.

Affected lines:

```css
/* Line ~210 */
.titlebar-action-btn:hover {
  background: var(--bg-hover); /* ← undefined, should be --hover-bg */
}

/* Line ~268 */
.preview-panel-action:hover {
  background: var(--bg-hover); /* ← undefined, should be --hover-bg */
}
```

**Fix:**

```css
.titlebar-action-btn:hover {
  background: var(--hover-bg);
}

.preview-panel-action:hover {
  background: var(--hover-bg);
}
```

---

### WR-03: Undefined CSS variable `--text-tertiary` (should be `--text-muted`)

**File:** `src/renderer/styles/ide.css:207, 255, 265`

**Issue:** `:root` defines three text variables — `--text-primary`, `--text-secondary`, and `--text-muted` — but three selectors use the non-existent `var(--text-tertiary)`. When undefined, CSS inherits color from the parent, resulting in incorrect text rendering (e.g., titlebar icons and preview-panel description text use black/inherited color instead of the intended `#5a5a5a`).

Affected selectors: `.titlebar-action-btn`, `.preview-panel-empty`, `.preview-panel-desc`.

**Fix:**

```css
.titlebar-action-btn {
  color: var(--text-muted); /* was var(--text-tertiary) */
}

.preview-panel-empty {
  color: var(--text-muted); /* was var(--text-tertiary) */
}

.preview-panel-desc {
  color: var(--text-muted); /* was var(--text-tertiary) */
}
```

---

### WR-04: `SettingsModal.handleSave()` catch block silently discards save errors

**File:** `src/renderer/components/chat/SettingsModal.tsx:107-112`

**Issue:** Phase C replaced silent catch blocks with Toast notifications, but the outer `try/catch` in `handleSave` was missed. If `updateSettings()` throws (e.g., IPC failure, validation error), the error is only written to `console.error` and the user sees nothing — the `saving` spinner just disappears.

```tsx
} catch (err) {
  console.error('Failed to save settings:', err)  // ← user sees nothing
} finally {
  setSaving(false)
}
```

**Fix:**

```tsx
} catch (err) {
  console.error('Failed to save settings:', err)
  useToastStore.getState().show('设置保存失败，请重试', 'error')
} finally {
  setSaving(false)
}
```

---

### WR-05: Symbol navigation results use `<a href="#">` — incorrect semantics

**File:** `src/renderer/components/chat/ToolCard.tsx:185`

**Issue:** The symbol navigation output renderer (`renderSymbolNavOutput`) renders each result as `<a href="#">`. Clicking this anchor scrolls the page to the top (or triggers a history entry) rather than performing the intended file-navigation action. `href="#"` is a placeholder that produces confusing UX and is not the correct semantic element for an action that does not navigate a URL.

```tsx
<a className="tool-card-web-url" href="#" title={r.filePath}>
  {r.filePath}:{r.line}
</a>
```

**Fix:** Use a `<button>` (or a `<span>` with `role="button"`) and wire up the intended navigation action:

```tsx
<button
  className="tool-card-web-url"
  type="button"
  title={r.filePath}
  onClick={() => {
    /* open file in editor at r.line */
  }}
>
  {r.filePath}:{r.line}
</button>
```

---

## Info

### IN-01: `--accent-primary` is undefined; hardcoded fallback `#58a6ff` overrides theme accent

**File:** `src/renderer/styles/tasks.css:76`

**Issue:** `.task-card-progress` uses `var(--accent-primary, #58a6ff)`. `--accent-primary` is not declared in `:root`; the fallback value `#58a6ff` (a GitHub-blue) is always used, which differs from the app's emerald-green `--accent: #10b981`. This looks like a variable name error rather than an intentional color choice.

**Fix:**

```css
.task-card-progress {
  color: var(--accent); /* was var(--accent-primary, #58a6ff) */
  background: rgba(16, 185, 129, 0.08); /* match --accent RGB */
}
```

---

### IN-02: `SettingsModal` overlay missing ARIA dialog semantics

**File:** `src/renderer/components/chat/SettingsModal.tsx:110-113`

**Issue:** The modal container has no `role="dialog"`, `aria-modal="true"`, or `aria-labelledby`. Screen readers treat it as a generic region and do not announce it as a modal or move virtual focus appropriately.

**Fix:**

```tsx
<div
  className="settings-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="settings-modal-title"
  onClick={(e) => e.stopPropagation()}
>
  <div className="settings-header">
    <h3 id="settings-modal-title">Settings</h3>  {/* add id */}
```

---

### IN-03: Debug `console.log` calls left in `StatusBar` production code

**File:** `src/renderer/components/ide/StatusBar.tsx:44, 49`

**Issue:** Two `console.log` calls logging relay status objects were left in production code. These add noise to the DevTools console in production.

```ts
console.log("[StatusBar] initial relay status:", JSON.stringify(status));
console.log("[StatusBar] relay status event:", JSON.stringify(status));
```

**Fix:** Remove both log lines (the error log on line 46 is appropriate to keep).

---

### IN-04: `AskUserQuestion` dismiss timer not cleared on unmount

**File:** `src/renderer/components/chat/AskUserQuestion.tsx:44`

**Issue:** `submit()` calls `setTimeout(() => onDismiss(questionId), 800)` but does not store the timer ID for cleanup. If the parent unmounts `AskUserQuestion` (e.g., a session switch) before the 800ms fires, the callback still executes on the stale closure. The risk is low since `onDismiss` only mutates parent state, but it bypasses React's unmount contract.

**Fix:**

```tsx
const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

// Inside submit():
if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
dismissTimerRef.current = setTimeout(() => onDismiss(questionId), 800);

// Add cleanup effect:
useEffect(
  () => () => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
  },
  [],
);
```

---

### IN-05: `MobileConnectModal` uses `as any` to access `token` from QR result

**File:** `src/renderer/components/ide/MobileConnectModal.tsx:27`

**Issue:** `(result as any).token` bypasses TypeScript's type checker. If the IPC return type is updated or the field is renamed, this silently breaks without a compile error.

**Fix:** Update the IPC return type for `getRelayQrCode` in `ipc-channels.ts` to include the optional field:

```ts
// In ipc-channels.ts, getRelayQrCode response type:
{ qrCode: string; token?: string }

// Then in MobileConnectModal:
if (result.token) setRelayToken(result.token)
```

---

_Reviewed: 2026-04-26_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
