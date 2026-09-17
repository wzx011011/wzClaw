// ============================================================
// node_catalog_service — 节点模型目录与默认模型（companion x/model/*）
//
// 协议（relay/zcode/companion.js handleXMethod，2026-09-16 定）：
// - x/model/catalog → {models:[{providerId,modelId,available,source}],
//   default:{providerId,modelId}|null, degraded:bool}
//   source: 'engine'=引擎实测可用（settings.model.available）；
//           'imported'=仅存在于 Companion 导入快照，未经引擎证实。
// - x/model/configure {providerId,modelId} → 默认模型落盘 companion
//   （0600，不写 ~/.zcode）+ 对活跃会话即时 setModel；
//   返回 {ok, appliedToActive, default}。
// - x/workspaces/list → {workspaces:[绝对路径], importedAt}；仅表示用户从
//   本机 ZCode 配置导入的候选工作区，不伪造会话或在线状态。
// 手机端新会话的默认模型应用见 startNewConversation 集成。
// ============================================================

import 'package:flutter/foundation.dart';

import 'connection_manager.dart';

class NodeModelEntry {
  final String providerId;
  final String modelId;

  /// 引擎实测可用（engine）还是仅快照收录（imported，未证实可用）
  final bool available;
  final String source;
  const NodeModelEntry({
    required this.providerId,
    required this.modelId,
    required this.available,
    required this.source,
  });

  String get key => '$providerId/$modelId';
}

class NodeModelCatalog {
  final List<NodeModelEntry> models;
  final NodeModelEntry? defaultModel;

  /// true = 引擎目录拉取失败，仅返回了导入快照（UI 应提示降级）
  final bool degraded;
  const NodeModelCatalog({
    required this.models,
    required this.defaultModel,
    required this.degraded,
  });
}

class ConfigureResult {
  final bool ok;
  final bool appliedToActive;
  const ConfigureResult({required this.ok, required this.appliedToActive});
}

class NodeCatalogService {
  NodeCatalogService._();
  static final NodeCatalogService instance = NodeCatalogService._();

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

  /// 节点模型目录（引擎可用 + 导入快照合并）。失败抛异常由调用方提示。
  Future<NodeModelCatalog> modelCatalog() async {
    final r = await _call('x/model/catalog');
    if (r is! Map) throw StateError('目录响应异常');
    final models = (r['models'] as List? ?? [])
        .whereType<Map>()
        .map(
          (m) => NodeModelEntry(
            providerId: m['providerId']?.toString() ?? '',
            modelId: m['modelId']?.toString() ?? '',
            available: m['available'] == true,
            source: m['source']?.toString() ?? '',
          ),
        )
        .where((m) => m.providerId.isNotEmpty && m.modelId.isNotEmpty)
        .toList();
    final def = r['default'];
    final defaultModel = def is Map
        ? NodeModelEntry(
            providerId: def['providerId']?.toString() ?? '',
            modelId: def['modelId']?.toString() ?? '',
            available: true,
            source: 'configured',
          )
        : null;
    return NodeModelCatalog(
      models: models,
      defaultModel: defaultModel != null &&
              defaultModel.providerId.isNotEmpty &&
              defaultModel.modelId.isNotEmpty
          ? defaultModel
          : null,
      degraded: r['degraded'] == true,
    );
  }

  /// Companion 导入快照中的工作区路径。引擎会话工作区仍由
  /// ZcodeChatStore.sessions 提供；UI 负责去重合并两种真实来源。
  Future<List<String>> importedWorkspaces() async {
    final r = await _call('x/workspaces/list');
    if (r is! Map) throw StateError('工作区响应异常');
    return (r['workspaces'] as List? ?? const [])
        .whereType<String>()
        .map((path) => path.trim())
        .where((path) => path.isNotEmpty)
        .toSet()
        .toList(growable: false);
  }

  /// 设置节点默认模型；同时尽量对活跃会话即时生效。
  Future<ConfigureResult> configureDefault({
    required String providerId,
    required String modelId,
  }) async {
    final r = await _call('x/model/configure', {
      'providerId': providerId,
      'modelId': modelId,
    });
    if (r is! Map || r['ok'] != true) throw StateError('设置默认模型失败');
    return ConfigureResult(
      ok: true,
      appliedToActive: r['appliedToActive'] == true,
    );
  }
}
