import 'dart:convert';

/// CreateWorkflow 工具调用的结构化显示（引擎 `state.metadata.display` /
/// live `tool.updated` result 的 `result.display`，两者同形）。
///
/// 协议源：vendor `toolCallCreateWorkflowDisplaySchema`（zcode-protocol.cjs
/// @25153）+ 2026-10-11 probe-workflow.js 实测（APP-SERVER.md「workflow 数据面
/// 实测」节）。字段按渲染面取舍：因果图只取阶段/车道/步骤/参与者/诊断——
/// handoffs/phaseEdges/exits/sink 是图形布局素材，卡片文字流水线不消费，
/// 不进模型（占位字段即缺陷）。
class ZcodeWorkflowDisplay {
  /// 编译是否通过（false = errorCount > 0，诊断列表必看）。
  final bool ok;
  final int errorCount;
  final List<ZcodeWorkflowDiagnostic> diagnostics;

  /// 因果图（缺席 = 引擎未给；渲染回退纯名字卡）。
  final ZcodeCausalityGraph? causalityGraph;

  /// 图被引擎截断（节点/车道超上限）。
  final bool truncated;

  const ZcodeWorkflowDisplay({
    required this.ok,
    required this.errorCount,
    required this.diagnostics,
    required this.causalityGraph,
    required this.truncated,
  });

  /// 非 create_workflow 形状（或缺字段）返回 null，调用方回退裸工具卡。
  static ZcodeWorkflowDisplay? fromEngineJson(dynamic raw) {
    if (raw is! Map || raw['kind'] != 'create_workflow') return null;
    return _fromMap(raw);
  }

  static ZcodeWorkflowDisplay? _fromMap(Map map) {
    final ok = map['ok'] is bool ? map['ok'] as bool : false;
    final errorCount = map['errorCount'] is int ? map['errorCount'] as int : 0;
    final diagnostics = <ZcodeWorkflowDiagnostic>[];
    final rawDiag = map['diagnostics'];
    if (rawDiag is List) {
      for (final d in rawDiag) {
        if (d is! Map) continue;
        final message = d['message'];
        if (message is! String || message.isEmpty) continue;
        diagnostics.add(ZcodeWorkflowDiagnostic(
          line: d['line'] is int ? d['line'] as int : 0,
          column: d['column'] is int ? d['column'] as int : 0,
          code: d['code'] is int ? d['code'] as int : 0,
          message: message,
        ),);
      }
    }
    return ZcodeWorkflowDisplay(
      ok: ok,
      errorCount: errorCount,
      diagnostics: List.unmodifiable(diagnostics),
      causalityGraph: ZcodeCausalityGraph.fromEngineJson(map['causalityGraph']),
      truncated: map['truncated'] == true,
    );
  }

  Map<String, dynamic> toJson() => {
        'kind': 'create_workflow',
        'ok': ok,
        'errorCount': errorCount,
        'diagnostics': [
          for (final d in diagnostics)
            {'line': d.line, 'column': d.column, 'code': d.code, 'message': d.message},
        ],
        if (causalityGraph != null) 'causalityGraph': causalityGraph!.toJson(),
        if (truncated) 'truncated': true,
      };

  /// 缓存反序列化（唯一写入方是 toJson，形状自洽；引擎路径经同一个 _fromMap）。
  static ZcodeWorkflowDisplay? fromCacheJson(dynamic raw) {
    if (raw is! Map || raw['kind'] != 'create_workflow') return null;
    final map =
        raw is Map<String, dynamic> ? raw : jsonDecode(jsonEncode(raw)) as Map<String, dynamic>;
    return _fromMap(map);
  }
}

class ZcodeWorkflowDiagnostic {
  final int line;
  final int column;
  final int code;
  final String message;

  const ZcodeWorkflowDiagnostic({
    required this.line,
    required this.column,
    required this.code,
    required this.message,
  });
}

/// 因果图投影：阶段（有序）→ 车道 → 步骤 → 参与者。
class ZcodeCausalityGraph {
  final List<ZcodeWorkflowStep> steps;
  final List<ZcodeWorkflowLane> lanes;
  final List<ZcodeWorkflowParticipant> participants;

  /// 作者 `phase()` 标记的阶段（表序）；无标记脚本为空表 → 渲染退回步骤视图。
  final List<ZcodeWorkflowPhase> phases;

  /// 图本体被引擎截断（节点/车道触上限；vendor causalityGraph.truncated）。
  final bool truncated;

  const ZcodeCausalityGraph({
    required this.steps,
    required this.lanes,
    required this.participants,
    required this.phases,
    required this.truncated,
  });

  static ZcodeCausalityGraph? fromEngineJson(dynamic raw) {
    if (raw is! Map) return null;
    return _build(
      raw['steps'],
      raw['lanes'],
      raw['participants'],
      raw['phases'],
      raw['truncated'] == true,
    );
  }

  static ZcodeCausalityGraph? _build(
    dynamic rawSteps,
    dynamic rawLanes,
    dynamic rawParticipants,
    dynamic rawPhases,
    bool truncated,
  ) {
    final steps = <ZcodeWorkflowStep>[];
    if (rawSteps is List) {
      for (final s in rawSteps) {
        if (s is! Map) continue;
        final id = s['id'];
        final label = s['label'];
        if (id is! String || label is! String) continue;
        steps.add(ZcodeWorkflowStep(
          id: id,
          kind: s['kind'] is String ? s['kind'] as String : 'ask',
          label: label,
          lane: s['lane'] is String ? s['lane'] as String : '',
          phase: s['phase'] is String ? s['phase'] as String : null,
        ),);
      }
    }
    final lanes = <ZcodeWorkflowLane>[];
    if (rawLanes is List) {
      for (final l in rawLanes) {
        if (l is! Map) continue;
        final id = l['id'];
        if (id is! String) continue;
        lanes.add(ZcodeWorkflowLane(
          id: id,
          name: l['name'] is String ? l['name'] as String : null,
        ),);
      }
    }
    final participants = <ZcodeWorkflowParticipant>[];
    if (rawParticipants is List) {
      for (final p in rawParticipants) {
        if (p is! Map) continue;
        final id = p['id'];
        final phase = p['phase'];
        final lane = p['lane'];
        if (id is! String || phase is! String || lane is! String) continue;
        final member = p['member'];
        participants.add(ZcodeWorkflowParticipant(
          id: id,
          phase: phase,
          lane: lane,
          steps: [
            if (p['steps'] is List)
              for (final s in p['steps'] as List)
                if (s is String) s,
          ],
          memberIndex: member is Map && member['index'] is int
              ? member['index'] as int
              : null,
          memberOf: member is Map && member['of'] is int ? member['of'] as int : null,
          many: p['many'] == true,
        ),);
      }
    }
    final phases = <ZcodeWorkflowPhase>[];
    if (rawPhases is List) {
      for (final p in rawPhases) {
        if (p is! Map) continue;
        final id = p['id'];
        if (id is! String) continue;
        phases.add(ZcodeWorkflowPhase(
          id: id,
          name: p['name'] is String ? p['name'] as String : null,
        ),);
      }
    }
    return ZcodeCausalityGraph(
      steps: List.unmodifiable(steps),
      lanes: List.unmodifiable(lanes),
      participants: List.unmodifiable(participants),
      phases: List.unmodifiable(phases),
      truncated: truncated,
    );
  }

  Map<String, dynamic> toJson() => {
        'steps': [
          for (final s in steps)
            {
              'id': s.id,
              'kind': s.kind,
              'label': s.label,
              'lane': s.lane,
              if (s.phase != null) 'phase': s.phase,
            },
        ],
        'lanes': [
          for (final l in lanes)
            {'id': l.id, if (l.name != null) 'name': l.name},
        ],
        'participants': [
          for (final p in participants)
            {
              'id': p.id,
              'phase': p.phase,
              'lane': p.lane,
              'steps': [...p.steps],
              if (p.memberIndex != null)
                'member': {'index': p.memberIndex, 'of': p.memberOf},
              if (p.many) 'many': true,
            },
        ],
        'phases': [
          for (final p in phases)
            {'id': p.id, if (p.name != null) 'name': p.name},
        ],
        if (truncated) 'truncated': true,
      };
}

class ZcodeWorkflowStep {
  final String id;

  /// `ask`（子代理询问）或 `world-read`（只读探查）。
  final String kind;
  final String label;
  final String lane;
  final String? phase;

  const ZcodeWorkflowStep({
    required this.id,
    required this.kind,
    required this.label,
    required this.lane,
    required this.phase,
  });
}

class ZcodeWorkflowLane {
  final String id;

  /// 车道显示名（agent 名）；缺席 = 模板串带洞的静态形状。
  final String? name;

  const ZcodeWorkflowLane({required this.id, required this.name});
}

class ZcodeWorkflowParticipant {
  final String id;
  final String phase;
  final String lane;
  final List<String> steps;

  /// fan-out 展开的成员序（index/of）；基数未知时 [many]。
  final int? memberIndex;
  final int? memberOf;
  final bool many;

  const ZcodeWorkflowParticipant({
    required this.id,
    required this.phase,
    required this.lane,
    required this.steps,
    required this.memberIndex,
    required this.memberOf,
    required this.many,
  });
}

class ZcodeWorkflowPhase {
  final String id;

  /// 作者标记名（`phase("…")`）；缺席 = `unphased` 兜底阶段，UI 本地化显示。
  final String? name;

  const ZcodeWorkflowPhase({required this.id, required this.name});
}
