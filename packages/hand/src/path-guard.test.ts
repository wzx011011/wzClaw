// ============================================================
// path-guard 单元测试
// ============================================================

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  getAllowedRoots,
  isPathInAllowedRoots,
  assertPathInWorkspace,
} from './path-guard.js'

describe('path-guard', () => {
  const root = path.resolve('/tmp/workspace-a')
  const other = path.resolve('/tmp/workspace-b')

  describe('getAllowedRoots', () => {
    it('projectRoots 优先于 workingDirectory', () => {
      const roots = getAllowedRoots({
        workingDirectory: '/tmp/wd',
        projectRoots: [root, other],
      })
      expect(roots).toEqual([root, other])
    })

    it('projectRoots 为空时回退到 workingDirectory', () => {
      const roots = getAllowedRoots({
        workingDirectory: root,
        projectRoots: [],
      })
      expect(roots).toEqual([root])
    })

    it('附加 extraAllowed 并去重', () => {
      const roots = getAllowedRoots(
        { workingDirectory: '', projectRoots: [root] },
        [root, other],
      )
      expect(roots).toEqual([root, other])
    })

    it('过滤空字符串', () => {
      const roots = getAllowedRoots(
        { workingDirectory: '', projectRoots: [] },
        ['', root],
      )
      expect(roots).toEqual([root])
    })
  })

  describe('isPathInAllowedRoots', () => {
    const allowed = [root]

    it('完全相等的根目录通过', () => {
      expect(isPathInAllowedRoots(root, allowed)).toBe(true)
    })

    it('子目录通过', () => {
      expect(isPathInAllowedRoots(path.join(root, 'sub', 'file.ts'), allowed)).toBe(true)
    })

    it('兄弟目录拒绝', () => {
      expect(isPathInAllowedRoots(other, allowed)).toBe(false)
    })

    it('包含 .. 跳转拼成的越界路径被拒绝', () => {
      const escaped = path.join(root, '..', 'workspace-b', 'secret.txt')
      expect(isPathInAllowedRoots(escaped, allowed)).toBe(false)
    })

    it('前缀字符串匹配但非子目录被拒绝（防 /tmp/workspace-a-evil）', () => {
      const sneaky = root + '-evil'
      expect(isPathInAllowedRoots(sneaky, allowed)).toBe(false)
    })

    it('空字符串/非字符串拒绝', () => {
      expect(isPathInAllowedRoots('', allowed)).toBe(false)
    })
  })

  describe('assertPathInWorkspace', () => {
    it('命中返回 null', () => {
      expect(
        assertPathInWorkspace(
          path.join(root, 'a.ts'),
          { workingDirectory: '', projectRoots: [root] },
        ),
      ).toBeNull()
    })

    it('未命中返回错误信封', () => {
      const v = assertPathInWorkspace(
        other,
        { workingDirectory: '', projectRoots: [root] },
      )
      expect(v).not.toBeNull()
      expect(v!.isError).toBe(true)
      expect(v!.output).toContain('路径不在允许范围内')
    })

    it('无任何 root + 无 extraAllowed 返回错误', () => {
      const v = assertPathInWorkspace(
        root,
        { workingDirectory: '', projectRoots: [] },
      )
      expect(v).not.toBeNull()
      expect(v!.output).toContain('无工作区配置')
    })

    it('extraAllowed 兜底命中（如 ShellExecute 的 DEFAULT_CWD）', () => {
      const v = assertPathInWorkspace(
        root,
        { workingDirectory: '', projectRoots: [] },
        [root],
      )
      expect(v).toBeNull()
    })
  })
})
