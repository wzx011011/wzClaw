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

  /// 显示名（模型 label，如 GLM-5.3-Flash；缺省回退 modelId）
  final String label;

  /// provider 显示名（如 BigModel / Claude CLI；缺省回退 providerId）
  final String providerLabel;

  /// 视觉输入支持（properties.inputFormat.supportsImage）
  final bool vision;

  /// 上下文窗口（token 数；null = 引擎未提供）
  final int? contextWindow;

  /// 套餐组（companion 注入的 BigModel 套餐 provider），手机端置顶展示
  final bool planGroup;
  const NodeModelEntry({
    required this.providerId,
    required this.modelId,
    required this.available,
    required this.source,
    this.label = '',
    this.providerLabel = '',
    this.vision = false,
    this.contextWindow,
    this.planGroup = false,
  });

  String get key => '$providerId/$modelId';

  /// 弹层分组名：provider 显示名优先，回退 providerId
  String groupLabel(String fallback) => providerLabel.isNotEmpty ? providerLabel : fallback;

  /// 行显示名：模型 label 优先；label 缺省或与 modelId 同文（引擎对第三方
  /// 模型常直接填 id，如 deepseek-v4-pro）时套用品牌美化，对齐官方
  /// 「GLM-5.3-Flash / DeepSeek-V4-Pro」的短名形态
  String get displayLabel {
    if (label.isNotEmpty && label.toLowerCase() != modelId.toLowerCase()) {
      return label; // 引擎给了与 id 不同的友好名：原样保留
    }
    return prettifyModelId(modelId);
  }

  /// modelId → 品牌化显示名。词表收录已知家族词；未收录词首字母大写兜底，
  /// 不丢字符——新模型上架无需改代码即可获得合理显示
  static String prettifyModelId(String modelId) {
    const known = {
      'glm': 'GLM',
      'gpt': 'GPT',
      'deepseek': 'DeepSeek',
      'opus': 'Opus',
      'sonnet': 'Sonnet',
      'haiku': 'Haiku',
      'mini': 'Mini',
      'flash': 'Flash',
      'flashx': 'FlashX',
      'pro': 'Pro',
      'chat': 'Chat',
      'reasoner': 'Reasoner',
      'air': 'Air',
      'lite': 'Lite',
      'max': 'Max',
    };
    return modelId
        .split(RegExp(r'[-_]')) // 点号属于尺寸段（5.3 / 1m），不拆
        .map((token) {
          if (token.isEmpty) return token;
          final lower = token.toLowerCase();
          if (known[lower] != null) return known[lower]!;
          if (RegExp(r'^v\d+$').hasMatch(lower)) return 'V${lower.substring(1)}';
          if (RegExp(r'^\d').hasMatch(token)) return token; // 5.3 / 1m 等尺寸段
          return token[0].toUpperCase() + token.substring(1);
        })
        .join('-');
  }
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
            label: m['label']?.toString() ?? '',
            providerLabel: m['providerLabel']?.toString() ?? '',
            vision: m['vision'] == true,
            contextWindow: m['contextWindow'] is int ? m['contextWindow'] as int : null,
            planGroup: m['planGroup'] == true,
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

  /// 设置节点默认模型（审查 P2-9 语义拆分）：只落盘默认值、新会话生效；
  /// 绝不隐式修改已有会话。唯一例外是显式传 [applySessionTarget]（目标
  /// sessionId），用于「模型不可用自愈」流程对当前会话的重试。
  Future<ConfigureResult> configureDefault({
    required String providerId,
    required String modelId,
    String? applySessionTarget,
  }) async {
    final r = await _call('x/model/configure', {
      'providerId': providerId,
      'modelId': modelId,
      if (applySessionTarget != null && applySessionTarget.isNotEmpty)
        'applySessionTarget': applySessionTarget,
    });
    if (r is! Map || r['ok'] != true) throw StateError('设置默认模型失败');
    return ConfigureResult(
      ok: true,
      appliedToActive: r['appliedToActive'] == true,
    );
  }
}
