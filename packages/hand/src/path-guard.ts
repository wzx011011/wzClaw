// ============================================================
// 路径白名单守卫 — 共享给所有 HandTool
// 保证工具仅能访问 agent-server 注入的工作区目录（context.projectRoots /
// context.workingDirectory），可选附加额外白名单（如 ShellExecute 的 /data 默认卷）。
// ============================================================

import path from 'node:path'

/** 与 HandTool.execute 第二参数兼容的最小 context 形状 */
export interface PathGuardContext {
  workingDirectory: string
  projectRoots: string[]
}

/**
 * 计算给定 context 下允许访问的根目录列表。
 *
 * 规则：
 * - 优先使用 `context.projectRoots`（agent-server 配置的工作区物理路径）。
 * - 若 projectRoots 为空，回退到 `context.workingDirectory`。
 * - 调用方可追加 `extraAllowed`（如 ShellExecute 的 DEFAULT_CWD）。
 * - 所有路径会经 `path.resolve` 标准化，过滤空串。
 */
export function getAllowedRoots(
  context: PathGuardContext,
  extraAllowed: string[] = [],
): string[] {
  const explicit = context.projectRoots && context.projectRoots.length > 0
    ? context.projectRoots
    : context.workingDirectory
      ? [context.workingDirectory]
      : []
  const all = [...explicit, ...extraAllowed]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map(s => path.resolve(s))
  // 去重
  return Array.from(new Set(all))
}

/**
 * 判断 targetPath 是否落在任一 allowedRoot 的子树内（包含等于）。
 * 使用 `path.resolve` 标准化以阻止 `..` 跳转和相对路径绕过。
 */
export function isPathInAllowedRoots(
  targetPath: string,
  allowedRoots: string[],
): boolean {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false
  const resolved = path.resolve(targetPath)
  return allowedRoots.some(root => {
    if (resolved === root) return true
    // 使用 path.sep 保证跨平台正确匹配 (\ on Windows, / on POSIX)
    return resolved.startsWith(root + path.sep)
  })
}

/**
 * 守卫函数：路径不在白名单时返回 HandTool 的错误信封，命中时返回 null。
 *
 * 用法：
 * ```ts
 * const violation = assertPathInWorkspace(filePath, context)
 * if (violation) return violation
 * ```
 */
export function assertPathInWorkspace(
  targetPath: string,
  context: PathGuardContext,
  extraAllowed: string[] = [],
): { output: string; isError: true } | null {
  const roots = getAllowedRoots(context, extraAllowed)
  if (roots.length === 0) {
    return {
      output: `路径不在允许范围内（无工作区配置）: ${targetPath}`,
      isError: true,
    }
  }
  if (!isPathInAllowedRoots(targetPath, roots)) {
    return {
      output: `路径不在允许范围内: ${targetPath}`,
      isError: true,
    }
  }
  return null
}
