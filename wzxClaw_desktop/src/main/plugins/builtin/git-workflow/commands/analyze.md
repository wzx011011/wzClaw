---
name: analyze
description: 深度分析当前分支的 git 历史，找出潜在问题
argumentHint: [branch]
---

深度分析当前分支的 git 历史。

步骤：
1. 运行 `git log --oneline -20` 查看最近的提交
2. 运行 `git branch -a` 查看所有分支
3. 检查是否有未提交的变更（`git status`）
4. 分析提交消息质量，给出改进建议

输出：
- 分支概览：当前分支、跟踪的远程分支
- 提交质量：消息格式是否规范、是否过于笼统
- 建议改进项
