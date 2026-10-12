// ============================================================
// zcode_workflow_display_test — create_workflow 显示结构契约
//
// 夹具 = probe-workflow.js 对真引擎的抓帧原文（2026-10-11，
// APP-SERVER.md「workflow 数据面实测」）。钉死：kind 门、字段映射、
// 缺字段容错、缓存往返不丢阶段/参与者/诊断。
// ============================================================

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/zcode/zcode_workflow_display.dart';

void main() {
  final fixtureFile = File('test/zcode/workflow_frames_fixture.json');
  final fixture = jsonDecode(fixtureFile.readAsStringSync()) as Map<String, dynamic>;
  final authoritativePart = fixture['authoritativePart'] as Map<String, dynamic>;
  final state = authoritativePart['state'] as Map<String, dynamic>;
  final metadata = state['metadata'] as Map<String, dynamic>;
  final engineDisplay = metadata['display'];

  test('引擎原文解析：kind 门 + 因果图全量映射', () {
    final display = ZcodeWorkflowDisplay.fromEngineJson(engineDisplay);
    expect(display, isNotNull);
    expect(display!.ok, isTrue);
    expect(display.errorCount, 0);
    expect(display.diagnostics, isEmpty);

    final graph = display.causalityGraph!;
    // probe-workflow 实测：单阶段 smoke / 单车道 smoke-worker / 单 ask 步
    expect(graph.phases, hasLength(1));
    expect(graph.phases.first.name, 'smoke');
    expect(graph.lanes, hasLength(1));
    expect(graph.lanes.first.name, 'smoke-worker');
    expect(graph.steps, hasLength(1));
    expect(graph.steps.first.kind, 'ask');
    expect(graph.steps.first.label, 'smoke-worker');
    expect(graph.steps.first.lane, 'actor#1');
    expect(graph.steps.first.phase, 'phase#1');
    expect(graph.participants, hasLength(1));
    expect(graph.participants.first.steps, ['ask#1']);
    expect(graph.participants.first.memberIndex, isNull);
    expect(graph.participants.first.many, isFalse);
    expect(graph.truncated, isFalse);
  });

  test('非 create_workflow 形状返回 null（回退裸工具卡）', () {
    expect(ZcodeWorkflowDisplay.fromEngineJson(null), isNull);
    expect(ZcodeWorkflowDisplay.fromEngineJson(<String, dynamic>{}), isNull);
    expect(
      ZcodeWorkflowDisplay.fromEngineJson(<String, dynamic>{
        'kind': 'other_tool',
        'ok': true,
      }),
      isNull,
    );
    // display 缺 causalityGraph（旧引擎/兜底形状）也要能立：图可空
    final bare = ZcodeWorkflowDisplay.fromEngineJson(<String, dynamic>{
      'kind': 'create_workflow',
      'ok': false,
      'errorCount': 2,
      'diagnostics': [
        {'line': 3, 'column': 7, 'code': 42, 'message': 'bad agent() call'},
        '垃圾条目',
        <String, dynamic>{},
      ],
    });
    expect(bare, isNotNull);
    expect(bare!.ok, isFalse);
    expect(bare.errorCount, 2);
    expect(bare.causalityGraph, isNull);
    // 只有 message 合法的诊断条目才收，其余丢弃不留占位
    expect(bare.diagnostics, hasLength(1));
    expect(bare.diagnostics.first.message, 'bad agent() call');
    expect(bare.diagnostics.first.line, 3);
  });

  test('缓存往返：阶段/车道/参与者/诊断零丢失', () {
    final display = ZcodeWorkflowDisplay.fromEngineJson(engineDisplay)!;
    final restored =
        ZcodeWorkflowDisplay.fromCacheJson(jsonDecode(jsonEncode(display.toJson())));
    expect(restored, isNotNull);
    expect(restored!.ok, display.ok);
    expect(restored.errorCount, display.errorCount);
    expect(restored.truncated, display.truncated);
    final graph = restored.causalityGraph!;
    expect(graph.phases.map((p) => p.name), ['smoke']);
    expect(graph.lanes.map((l) => l.name), ['smoke-worker']);
    expect(graph.steps.map((s) => s.label), ['smoke-worker']);
    expect(graph.participants.first.steps, ['ask#1']);
    expect(restored.diagnostics, isEmpty);
  });

  test('fan-out 参与者：member{index,of} 与 many 卡保真', () {
    final graph = ZcodeCausalityGraph.fromEngineJson(<String, dynamic>{
      'steps': [],
      'lanes': [
        {'id': 'actor#1', 'name': 'judge'},
      ],
      'participants': [
        {
          'id': 'phase#1:actor#1',
          'phase': 'phase#1',
          'lane': 'actor#1',
          'steps': ['ask#1', 'ask#2'],
          'member': {'index': 0, 'of': 4},
        },
        {
          'id': 'phase#1:actor#2',
          'phase': 'phase#1',
          'lane': 'actor#2',
          'steps': ['ask#3'],
          'many': true,
        },
      ],
      'phases': [
        {'id': 'phase#1', 'name': 'batch'},
      ],
      'truncated': true,
    });
    expect(graph, isNotNull);
    expect(graph!.participants.first.memberIndex, 0);
    expect(graph.participants.first.memberOf, 4);
    expect(graph.participants.first.steps, hasLength(2));
    expect(graph.participants[1].many, isTrue);
    expect(graph.truncated, isTrue);
  });
}
