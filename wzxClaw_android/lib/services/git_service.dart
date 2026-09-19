// ============================================================
// git_service — 桌面 git 状态/分支操作（companion x/* 扩展）
//
// 协议见 relay/zcode/APP-SERVER.md「companion 本地扩展协议 x/*」：
// app-server 不暴露 git 接口（probe-git.js 实测 13 个候选全 404），
// 由 companion 在桌面本机执行真实 git 命令。任何失败显性上浮或降级
// 为「不显示」，不做假成功。
// ============================================================

import 'package:flutter/foundation.dart';

import 'connection_manager.dart';

class GitBranchInfo {
  final String name;
  final bool current;
  const GitBranchInfo({required this.name, required this.current});
}

/// 状态面板「Git 工具」板块的仓库摘要
class GitRepoStatus {
  /// 当前分支；detached HEAD 为空串
  final String branch;

  /// 变更条目数（x/git/status 的 dirty，含 untracked）
  final int dirty;

  /// 行级增删（x/git/diffstat；untracked 不计入）
  final int added;
  final int removed;

  const GitRepoStatus({
    required this.branch,
    required this.dirty,
    required this.added,
    required this.removed,
  });

  bool get hasChanges => dirty > 0 || added > 0 || removed > 0;
}

/// 推送对话框数据（x/git/pushinfo）
class GitPushInfo {
  final String branch;
  final bool hasRemote;
  final String upstream;
  final int ahead;
  final int behind;

  const GitPushInfo({
    required this.branch,
    required this.hasRemote,
    required this.upstream,
    required this.ahead,
    required this.behind,
  });

  bool get hasUpstream => upstream.isNotEmpty;
}

class GitService {
  GitService._();
  static final GitService instance = GitService._();

  /// 仅测试使用：注入请求实现（默认走 ConnectionManager.zcodeRequest）
  @visibleForTesting
  static Future<dynamic> Function(
    String method, [
    Map<String, dynamic>? params,
  ])? debugRequester;

  Future<dynamic> _call(String method, [Map<String, dynamic>? params]) {
    final requester = debugRequester;
    if (requester != null) return requester(method, params);
    return ConnectionManager.instance.zcodeRequest(method, params);
  }

  /// 当前工作区分支；null = 未知/不可用（非 git 仓库、桌面无 git、未连接），
  /// UI 据此降级为只显示「分支」按钮
  final ValueNotifier<String?> currentBranch = ValueNotifier<String?>(null);

  /// 拉取工作区当前分支并更新 [currentBranch]
  Future<void> refreshBranch(String? workspacePath) async {
    if (workspacePath == null || workspacePath.isEmpty) {
      currentBranch.value = null;
      return;
    }
    try {
      final r = await _call('x/git/status', {'path': workspacePath});
      final branch = (r is Map) ? (r['branch']?.toString() ?? '') : '';
      currentBranch.value = branch.isEmpty ? null : branch;
    } catch (_) {
      // 非 git 仓库 / detached HEAD / 通道失败：如实降级，不猜
      currentBranch.value = null;
    }
  }

  /// 分支列表（含 current 标记）
  Future<List<GitBranchInfo>> branches(String workspacePath) async {
    final r = await _call('x/git/branches', {'path': workspacePath});
    if (r is! Map) throw StateError('分支列表响应异常');
    final list = <GitBranchInfo>[];
    for (final e in (r['branches'] as List? ?? [])) {
      final m = Map<String, dynamic>.from(e as Map);
      list.add(
        GitBranchInfo(
          name: m['name']?.toString() ?? '',
          current: m['current'] == true,
        ),
      );
    }
    return list;
  }

  /// 检出分支；[create] 为 true 时新建并检出
  Future<void> checkout(
    String workspacePath,
    String branch, {
    bool create = false,
  }) async {
    await _call('x/git/checkout', {
      'path': workspacePath,
      'branch': branch,
      if (create) 'create': true,
    });
  }

  /// 批量目录存在性（工作区列表过滤已删除路径用）
  Future<List<bool>> existingDirs(List<String> paths) async {
    final r = await _call('x/fs/exists', {'paths': paths});
    if (r is! Map) throw StateError('exists 响应异常');
    return [for (final v in (r['exists'] as List? ?? [])) v == true];
  }

  /// 仓库摘要（状态面板「Git 工具」板块数据源）。非 git 仓库 / git 不可用 /
  /// 离线一律抛错，由调用方决定隐藏板块——不做假数据。
  Future<GitRepoStatus> repoStatus(String workspacePath) async {
    final st = await _call('x/git/status', {'path': workspacePath});
    if (st is! Map) throw StateError('git status 响应异常');
    final ds = await _call('x/git/diffstat', {'path': workspacePath});
    return GitRepoStatus(
      branch: st['branch']?.toString() ?? '',
      dirty: (st['dirty'] as num?)?.toInt() ?? 0,
      added: ds is Map ? (ds['added'] as num?)?.toInt() ?? 0 : 0,
      removed: ds is Map ? (ds['removed'] as num?)?.toInt() ?? 0 : 0,
    );
  }

  /// 推送对话框数据（分支/upstream/领先落后）
  Future<GitPushInfo> pushInfo(String workspacePath) async {
    final r = await _call('x/git/pushinfo', {'path': workspacePath});
    if (r is! Map) throw StateError('pushinfo 响应异常');
    return GitPushInfo(
      branch: r['branch']?.toString() ?? '',
      hasRemote: r['hasRemote'] == true,
      upstream: r['upstream']?.toString() ?? '',
      ahead: (r['ahead'] as num?)?.toInt() ?? 0,
      behind: (r['behind'] as num?)?.toInt() ?? 0,
    );
  }

  /// 提交；[includeUnstaged] 为 true 时先 add -A。失败抛错（message 可读）
  Future<String> commit(
    String workspacePath,
    String message, {
    bool includeUnstaged = false,
  }) async {
    final r = await _call('x/git/commit', {
      'path': workspacePath,
      'message': message,
      if (includeUnstaged) 'includeUnstaged': true,
    });
    if (r is! Map || r['ok'] != true) throw StateError('提交响应异常');
    return r['hash']?.toString() ?? '';
  }

  /// 推送；无 upstream 时必须 [setUpstream] = true
  Future<void> push(String workspacePath, {bool setUpstream = false}) async {
    await _call('x/git/push', {
      'path': workspacePath,
      if (setUpstream) 'setUpstream': true,
    });
  }
}
