// ============================================================
// node_fs_service — 桌面节点目录浏览（companion x/fs/dirs 扩展）
//
// 新建会话自选工作区的数据源。协议见 relay/zcode/APP-SERVER.md
// 「companion 本地扩展协议 x/*」：app-server 无任何文件系统方法
// （workspace/* 实测全 -32601），目录列举由 companion 在桌面本机
// 执行；session/create 接受任意未注册目录（probe-wscreate.js 实测）。
// 任何失败显性抛出，由 UI 提示重试，不做假列表。
// ============================================================

import 'package:flutter/foundation.dart';

import 'connection_manager.dart';

/// 一个可进入的目录条目
class NodeDirEntry {
  final String name;
  final String path;
  const NodeDirEntry({required this.name, required this.path});
}

/// 一次目录列举结果
class NodeDirListing {
  /// 当前目录绝对路径；根模式（请求未带 path）为 ''
  final String path;

  /// 上级目录；盘符根为 null（没有更上级）
  final String? parent;

  /// 节点用户主目录（UI 提供「主目录」快捷跳转）
  final String home;

  /// 直接子目录（已过滤 symlink/系统垃圾目录，按名排序）
  final List<NodeDirEntry> dirs;

  const NodeDirListing({
    required this.path,
    required this.parent,
    required this.home,
    required this.dirs,
  });

  /// 根模式：path 为空，条目是盘符/根，没有「当前目录」可选
  bool get isRoot => path.isEmpty;
}

class NodeFsService {
  NodeFsService._();
  static final NodeFsService instance = NodeFsService._();

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

  /// 列举 [path] 的直接子目录；null/空 = 根模式（盘符 + 主目录）
  Future<NodeDirListing> listDirs({String? path}) async {
    final clean = (path ?? '').trim();
    final r = await _call(
      'x/fs/dirs',
      clean.isEmpty ? null : {'path': clean},
    );
    if (r is! Map) throw StateError('目录列举响应异常');
    final rawDirs = r['dirs'];
    final dirs = <NodeDirEntry>[];
    if (rawDirs is List) {
      for (final e in rawDirs) {
        if (e is! Map) continue;
        final name = e['name']?.toString() ?? '';
        final dirPath = e['path']?.toString() ?? '';
        if (name.isEmpty || dirPath.isEmpty) continue;
        dirs.add(NodeDirEntry(name: name, path: dirPath));
      }
    }
    final parentRaw = r['parent']?.toString();
    return NodeDirListing(
      path: r['path']?.toString() ?? '',
      parent: (parentRaw == null || parentRaw.isEmpty) ? null : parentRaw,
      home: r['home']?.toString() ?? '',
      dirs: dirs,
    );
  }
}
