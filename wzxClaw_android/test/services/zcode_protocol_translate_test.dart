// 换芯层协议翻译回归测试：审查整改项的契约锚定
// 1) 权限应答必须回放 option.response 原文（其它形状被服务端静默 deny）
// 2) 工具事件按实测 kind 轨迹（scheduled/started/result）翻译
// 3) 权限/AskUser 反向请求解析（含 options 原文与 requestKey）
// 4) callID 大小写、hasMore 推算、配对链接宽容 scheme
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/goal_snapshot.dart';
import 'package:wzxclaw_android/models/ws_message.dart';
import 'package:wzxclaw_android/services/zcode_protocol_translate.dart';

void main() {
  group('parsePairingUrlAny', () {
    test('https 与 wss 均可，host/port 正确', () {
      final a = parsePairingUrlAny(
          'https://zcode.5945.top/pair?sid=abc&hash=xxx',);
      expect(a!.relayWsUrl, 'wss://zcode.5945.top/ws');
      final b = parsePairingUrlAny(
          'wss://zcode.5945.top/pair?sid=abc&hash=xxx',);
      expect(b!.relayWsUrl, 'wss://zcode.5945.top/ws');
      expect(parsePairingUrlAny('wss://host/ws?sid='), isNull);
    });
  });

  group('normalizeQrScanToServerUrl（扫码配对链接归一化）', () {
    test('https 配对链接升级为 wss，sid/hash/name 参数原样保留', () {
      final url = normalizeQrScanToServerUrl(
          'https://zcode.5945.top/pair?sid=abc&hash=xxx&name=MY-PC',);
      expect(url, 'wss://zcode.5945.top/pair?sid=abc&hash=xxx&name=MY-PC');
      // 归一化结果必须能被 connect() 直接接受（parsePairingUrlAny 非 null）
      expect(parsePairingUrlAny(url!), isNotNull);
    });

    test('wss 配对链接原样返回；非配对链接返回 null 走旧后处理', () {
      expect(normalizeQrScanToServerUrl('wss://zcode.5945.top/pair?sid=a&hash=b'),
          'wss://zcode.5945.top/pair?sid=a&hash=b',);
      // 旧 token 二维码（无 sid+hash）：返回 null，不能被误当配对链接
      expect(normalizeQrScanToServerUrl('https://5945.top/relay/?token=tok123'),
          isNull,);
      expect(normalizeQrScanToServerUrl('wss://5945.top/relay/'), isNull);
    });
  });

  group('工作区分组（session/list 聚合）', () {
    final listResult = {
      'sessions': [
        {
          'sessionId': 's1', 'title': '老会话', 'status': 'idle',
          'createdAt': 1, 'updatedAt': 100,
          'workspace': {'workspaceKey': 'E:\\ai\\wzxClaw', 'workspacePath': 'E:\\ai\\wzxClaw'},
        },
        {
          'sessionId': 's2', 'title': '新会话', 'status': 'running',
          'createdAt': 2, 'updatedAt': 900,
          'workspace': {'workspaceKey': 'E:\\ai\\wzxClaw', 'workspacePath': 'E:\\ai\\wzxClaw'},
        },
        {
          'sessionId': 's3', 'title': '打印机', 'status': 'idle',
          'createdAt': 3, 'updatedAt': 500,
          'workspace': {'workspaceKey': 'E:\\ai\\3DPrinter', 'workspacePath': 'E:\\ai\\3DPrinter'},
        },
      ],
    };

    test('按 workspaceKey 分组，最新活跃在前，行字段映射完整', () {
      final groups = groupSessionsByWorkspace(listResult);
      expect(groups.length, 2);
      expect(groups.first.key, 'E:\\ai\\wzxClaw'); // updatedAt 900 > 500
      expect(groups.first.sessions.length, 2);
      final row = groups.first.sessions.first;
      expect(row['id'], 's1');
      expect(row['isRunning'], false);
      expect(groups.first.sessions[1]['isRunning'], true);
      expect(groups.last.key, 'E:\\ai\\3DPrinter');
    });

    test('workspaceListWsResponse：新格式（id+title+内嵌 sessions）', () {
      final groups = groupSessionsByWorkspace(listResult);
      final data = workspaceListWsResponse('r1', groups).data as Map;
      final wsList = data['workspaces'] as List;
      final first = wsList.first as Map;
      // SessionSyncService 新格式分支要求 id+title 键存在
      expect(first.containsKey('id') && first.containsKey('title'), true);
      expect(first['title'], 'wzxClaw');
      expect((first['sessions'] as List).length, 2);
      expect((first['projects'] as List).first,
          containsPair('path', 'E:\\ai\\wzxClaw'),);
      expect(first['runningSessionIds'], ['s2']);
    });

    test('sessionListWsResponse：选中组过滤 + 顶层工作区字段；缺省=最新组', () {
      final groups = groupSessionsByWorkspace(listResult);
      final selected = sessionListWsResponse('r1', groups, 'E:\\ai\\3DPrinter').data as Map;
      expect(selected['workspaceName'], '3DPrinter');
      expect(selected['workspacePath'], 'E:\\ai\\3DPrinter');
      expect((selected['sessions'] as List).length, 1);

      final def = sessionListWsResponse('r1', groups, null).data as Map;
      expect(def['workspaceName'], 'wzxClaw');
      expect((def['sessions'] as List).length, 2);
      expect(def['runningSessionIds'], ['s2']);

      // 键未命中 → 空工作区（UI 显示未选择，可重选），不静默换组
      final miss = sessionListWsResponse('r1', groups, '不存在的键').data as Map;
      expect((miss['sessions'] as List), isEmpty);
      expect(miss['workspacePath'], '');
    });

    test('路径大小写不一致仍按 workspaceKey 归组；切换按路径兜底匹配', () {
      final result = {
        'sessions': [
          {
            'sessionId': 'a', 'title': 't', 'status': 'idle', 'updatedAt': 1,
            'workspace': {'workspaceKey': 'K', 'workspacePath': 'e:\\AI\\X'},
          },
          {
            'sessionId': 'b', 'title': 't', 'status': 'idle', 'updatedAt': 2,
            'workspace': {'workspaceKey': 'K', 'workspacePath': 'E:\\ai\\X'},
          },
        ],
      };
      final groups = groupSessionsByWorkspace(result);
      expect(groups.length, 1);
      expect(groups.single.sessions.length, 2);
      expect(resolveWorkspace(groups, 'e:\\ai\\x')!.key, 'K');
    });
  });

  group('权限反向请求翻译', () {
    test('options 原文透传（含 response 模板）+ requestId 作 key', () {
      final registered = <String, ReverseRequestInfo>{};
      final events = translateNotification(
        'interaction/requestPermission',
        {
          'id': 'server-1',
          'method': 'interaction/requestPermission',
          'params': {
            'requestId': 'perm_1',
            'toolCallId': 'call_1',
            'toolName': 'Bash',
            'options': [
              {
                'optionId': 'allow_once',
                'response': {'decision': 'allow', 'reason': 'Approved once'},
              },
              {
                'optionId': 'deny',
                'response': {'decision': 'deny', 'reason': 'Denied'},
              },
            ],
          },
        },
        (info, event) {
          final d = event.data as Map;
          registered[d['requestId'].toString()] = info;
        },
      );
      expect(events.single.event, 'stream:agent:permission_request');
      final data = events.single.data as Map;
      expect(data['requestId'], 'perm_1');
      expect((data['options'] as List).length, 2);
      // 登记信息携带 options 原文（应答回放依赖）
      final info = registered['perm_1']!;
      expect(info.permissionOptions!.length, 2);
      expect(info.permissionOptions!.first['response'],
          {'decision': 'allow', 'reason': 'Approved once'},);
    });
  });

  group('工具事件 kind 轨迹（实测校准）', () {
    test('scheduled/started → tool_call；result → tool_result（result.content）', () {
      final call = _payload({'kind': 'scheduled', 'toolCallId': 'c1', 'toolName': 'Bash'});
      expect(call.single.event, 'stream:agent:tool_call');
      expect(call.single.data, containsPair('toolCallId', 'c1'));

      final started = _payload({'kind': 'started', 'toolCallId': 'c1', 'toolName': 'Bash'});
      expect(started.single.event, 'stream:agent:tool_call');

      final result = _payload({
        'kind': 'result',
        'toolCallId': 'c1',
        'result': {'success': true, 'content': 'hello'},
      });
      expect(result.single.event, 'stream:agent:tool_result');
      expect(result.single.data, containsPair('output', 'hello'));
      expect(result.single.data, containsPair('isError', false));
    });

    test('result.success=false → isError', () {
      final result = _payload({
        'kind': 'result',
        'toolCallId': 'c1',
        'result': {'success': false, 'content': 'boom'},
      });
      expect(result.single.data, containsPair('isError', true));
    });

    test('progress/batch 不产出事件（不崩、不误译）', () {
      expect(_payload({'kind': 'progress', 'toolCallId': 'c1'}), isEmpty);
      expect(_payload({'kind': 'batch'}), isEmpty);
    });

    test('permission.resolved 翻译为待清事件', () {
      final events = _payload({
        'kind': 'permission.resolved',
        'requestId': 'perm_1',
        'toolCallId': 'c1',
        'decision': 'deny',
      });
      expect(events.single.event, 'stream:agent:permission_resolved');
    });
  });

  group('实测单事件形状（probe-stream-shape 词表校准）', () {
    // 生产推送是单事件：params={sessionId,type,payload,...}，语义载荷在
    // payload 内。回归锚点：解包 bug 曾导致所有单事件帧零翻译（空白根因）。
    test('model.streaming text_delta → stream:agent:text', () {
      final events = translateNotification('session/event', {
        'sessionId': 's1',
        'type': 'model.streaming',
        'payload': {'kind': 'text_delta', 'delta': '你好', 'done': false},
      }, (_, __) {},);
      expect(events.single.event, 'stream:agent:text');
      expect(events.single.data, containsPair('content', '你好'));
    });

    test('reasoning_delta → stream:agent:thinking；tool_input_delta/end 忽略', () {
      final think = translateNotification('session/event', {
        'sessionId': 's1',
        'type': 'model.streaming',
        'payload': {'kind': 'reasoning_delta', 'delta': '先想想'},
      }, (_, __) {},);
      expect(think.single.event, 'stream:agent:thinking');

      expect(
        translateNotification('session/event', {
          'sessionId': 's1',
          'type': 'model.streaming',
          'payload': {'kind': 'tool_input_delta', 'delta': '{"command"', 'toolCallId': 'c1'},
        }, (_, __) {},),
        isEmpty,
      );
      expect(
        translateNotification('session/event', {
          'sessionId': 's1',
          'type': 'model.streaming',
          'payload': {'kind': 'tool_input_end', 'toolCallId': 'c1'},
        }, (_, __) {},),
        isEmpty,
      );
    });

    test('tool_input_start 建占位卡；tool_call 补全完整 input 对象', () {
      final start = translateNotification('session/event', {
        'sessionId': 's1',
        'type': 'model.streaming',
        'payload': {'kind': 'tool_input_start', 'toolCallId': 'c1', 'toolName': 'Bash'},
      }, (_, __) {},);
      expect(start.single.event, 'stream:agent:tool_call');
      expect(start.single.data, containsPair('toolName', 'Bash'));

      final call = translateNotification('session/event', {
        'sessionId': 's1',
        'type': 'model.streaming',
        'payload': {
          'kind': 'tool_call',
          'toolCallId': 'c1',
          'toolName': 'Bash',
          'input': {'command': 'echo hi'},
        },
      }, (_, __) {},);
      expect(call.single.event, 'stream:agent:tool_call');
      expect((call.single.data as Map)['input'], containsPair('command', 'echo hi'));
    });

    test('type=turn.completed → turn_end + done（usage + durationMs）', () {
      final events = translateNotification('session/event', {
        'sessionId': 's1',
        'type': 'turn.completed',
        'payload': {
          'resultType': 'success',
          'duration': 127000,
          'usage': {'inputTokens': 100, 'outputTokens': 5},
        },
      }, (_, __) {},);
      expect(events[0].event, 'stream:agent:turn_end');
      expect(events[1].event, 'stream:agent:done');
      expect((events[1].data as Map)['durationMs'], 127000);
      expect(((events[1].data as Map)['usage'] as Map), containsPair('inputTokens', 100));
    });

    test('type=turn.started → running；type=permission.resolved（无 kind）→ 待清', () {
      final running = translateNotification('session/event', {
        'sessionId': 's1',
        'type': 'turn.started',
        'payload': {'turnNumber': 0},
      }, (_, __) {},);
      expect(running.single.event, 'stream:agent:running');

      final resolved = translateNotification('session/event', {
        'sessionId': 's1',
        'type': 'permission.resolved',
        'payload': {'toolCallId': 'c1', 'decision': 'approved'},
      }, (_, __) {},);
      expect(resolved.single.event, 'stream:agent:permission_resolved');
    });

    test('title/steer/recovery 等无关事件零产出（不误译为文本/工具结果）', () {
      for (final t in ['session.titleUpdated', 'session.updated', 'turn.steerQueued']) {
        expect(
          translateNotification('session/event', {
            'sessionId': 's1',
            'type': t,
            'payload': {'title': 'x'},
          }, (_, __) {},),
          isEmpty,
          reason: t,
        );
      }
      // streamRecovery 的 payload 自带 kind=tool_result（簿记），必须整体跳过
      expect(
        translateNotification('session/event', {
          'sessionId': 's1',
          'type': 'streamRecovery.updated',
          'payload': {'kind': 'tool_result', 'toolCallId': 'c1', 'resultPartId': 'p1'},
        }, (_, __) {},),
        isEmpty,
      );
    });
  });

  group('历史消息映射', () {
    test('callID（大写 D 权威字段）被读取', () {
      final events = responseToWsMessages('session/messages', {
        'messages': [
          {
            'info': {'role': 'assistant', 'time': {'created': 1}},
            'parts': [
              {'type': 'text', 'text': 'x'},
              {
                'type': 'tool',
                'callID': 'callID_1',
                'tool': 'Bash',
                'state': {'status': 'completed'},
              },
            ],
          },
        ],
      }, const {},);
      final msg = (events.single.data as Map)['messages'].single as Map;
      expect((msg['tool_calls'] as List).single,
          containsPair('toolCallId', 'callID_1'),);
    });

    test('state.input 为 Map 时派生单行摘要（command/file_path/pattern）', () {
      final events = responseToWsMessages('session/messages', {
        'messages': [
          {
            'info': {'role': 'assistant', 'time': {'created': 1}},
            'parts': [
              {
                'type': 'tool',
                'callID': 'c1',
                'tool': 'Bash',
                'state': {
                  'status': 'completed',
                  'input': {'command': 'echo hi', 'timeout': 1000},
                },
              },
              {
                'type': 'tool',
                'callID': 'c2',
                'tool': 'Read',
                'state': {
                  'status': 'completed',
                  'input': {'file_path': '/tmp/a.txt'},
                },
              },
              {
                'type': 'tool',
                'callID': 'c3',
                'tool': 'Grep',
                'state': {
                  'status': 'error',
                  'input': {'pattern': 'foo.*bar'},
                },
              },
            ],
          },
        ],
      }, const {},);
      final calls =
          ((events.single.data as Map)['messages'].single as Map)['tool_calls'] as List;
      expect(calls[0], containsPair('inputSummary', 'echo hi'));
      expect(calls[1], containsPair('inputSummary', '/tmp/a.txt'));
      expect(calls[2], containsPair('inputSummary', 'foo.*bar'));
      expect(calls[2], containsPair('status', 'error'));
    });

    test('纯工具助手行（无 text part）不丢行（APP-SERVER.md 364）', () {
      final events = responseToWsMessages('session/messages', {
        'messages': [
          {
            'info': {'role': 'assistant', 'time': {'created': 1}},
            'parts': [
              {'type': 'step-start'},
              {
                'type': 'tool',
                'callID': 'c9',
                'tool': 'Bash',
                'state': {'status': 'completed'},
              },
              {'type': 'step-finish', 'tokens': {'total': 10, 'output': 2}},
            ],
          },
        ],
      }, const {},);
      final msgs = (events.single.data as Map)['messages'] as List;
      expect(msgs, hasLength(1));
      expect((msgs.single as Map)['tool_calls'], isNotNull);
    });

    test('hasMore 恒 false（尾窗语义诚实化——返回条数与 limit 无关）', () {
      // 回归锚：曾按「条数==limit」推算 hasMore=true，叠加响应 offset 恒 0，
      // 导致 ≥200 条会话在 loadAll 中无限翻页、时间线整片重复
      final events = responseToWsMessages('session/messages', {
        'messages': List.generate(200, (i) => {
              'info': {'role': 'user', 'time': {'created': i}},
              'parts': [
                {'type': 'text', 'text': 'm$i'},
              ],
            },),
      }, const {},);
      expect((events.single.data as Map)['hasMore'], false);

      // 少量消息同样 false
      final small = responseToWsMessages('session/messages', {
        'messages': [
          {
            'info': {'role': 'user', 'time': {'created': 1}},
            'parts': [
              {'type': 'text', 'text': 'only'},
            ],
          },
        ],
      }, const {},);
      expect((small.single.data as Map)['hasMore'], false);
    });

    test('info.agent 透传到消息行（子智能体归属）', () {
      final events = responseToWsMessages('session/messages', {
        'messages': [
          {
            'info': {
              'role': 'assistant',
              'agent': 'general-purpose',
              'time': {'created': 1},
            },
            'parts': [
              {'type': 'text', 'text': '子线程输出'},
            ],
          },
          {
            'info': {
              'role': 'assistant',
              'agent': 'zcode-agent',
              'time': {'created': 2},
            },
            'parts': [
              {'type': 'text', 'text': '主线输出'},
            ],
          },
          {
            'info': {
              'role': 'assistant',
              'time': {'created': 3},
            },
            'parts': [
              {'type': 'text', 'text': '无 agent'},
            ],
          },
        ],
      }, const {},);
      final rows = (events.single.data as Map)['messages'] as List;
      expect(rows[0]['agent'], 'general-purpose');
      expect(rows[1]['agent'], 'zcode-agent');
      expect(rows[2]['agent'], isNull);
    });
  });

  group('悬浮窗快照解析（session/goal）', () {
    test('todos/todoGroups/goalStats 全量解析', () {
      final s = parseGoalSnapshot({
        'todos': [
          {'content': 'a', 'status': 'completed', 'priority': 'high'},
          {
            'content': 'b',
            'status': 'in_progress',
            'activeForm': '正在 b',
          },
        ],
        'todoGroups': [
          {
            'id': 'g1',
            'source': 'session',
            'startedAt': 1000,
            'updatedAt': 5000,
            'todos': [
              {'content': 'a', 'status': 'completed'},
            ],
          },
          {
            'id': 'p1',
            'source': 'plan',
            'todos': [],
          },
        ],
        'goalStats': {
          'contextUsed': 100,
          'contextWindow': 200,
          'iterationCount': 3,
          'timeUsedSeconds': 42,
          'tokensUsed': 500,
          'toolCallCount': 7,
        },
      });
      expect(s.todos.length, 2);
      expect(s.todos[0].isCompleted, true);
      expect(s.todos[1].activeForm, '正在 b');
      expect(s.groups.length, 2);
      expect(s.groups[0].completedCount, 1);
      expect(s.groups[1].isPlan, true);
      expect(s.plans.length, 1);
      expect(s.stats?.contextRatio, 0.5);
      expect(s.stats?.toolCallCount, 7);
      expect(s.isEmpty, false);
      // groups[0] 已全部完成 → activeGroup 回退取最后组
      expect(identical(s.activeGroup, s.groups[1]), true);
    });

    test('非 Map（错误帧 result）→ 空快照', () {
      expect(parseGoalSnapshot(null).isEmpty, true);
      expect(parseGoalSnapshot('x').isEmpty, true);
    });

    test('toLegacyTodo 映射旧协议 todo:updated 行', () {
      const t = GoalTodo(
          content: 'x', status: 'in_progress', activeForm: '做 x',);
      expect(t.toLegacyTodo(), {
        'content': 'x',
        'status': 'in_progress',
        'activeForm': '做 x',
      });
    });
  });

  group('子智能体线程解析（session/subagents action:show）', () {
    test('按 info.agent 聚合 + 最新线程在前', () {
      final threads = parseSubagentThreads({
        'messages': [
          {
            'info': {
              'role': 'assistant',
              'agent': 'a1',
              'time': {'created': 100},
            },
            'parts': [
              {'type': 'text', 'text': 'a1-msg'},
            ],
          },
          {
            'info': {
              'role': 'assistant',
              'agent': 'a2',
              'time': {'created': 300},
            },
            'parts': [
              {'type': 'text', 'text': 'a2-msg'},
            ],
          },
          {
            'info': {
              'role': 'assistant',
              'agent': 'a1',
              'time': {'created': 200},
            },
            'parts': [
              {'type': 'text', 'text': 'a1-msg2'},
            ],
          },
        ],
      });
      expect(threads.length, 2);
      expect(threads[0].agent, 'a2'); // 最新消息 300 在前
      expect(threads[1].agent, 'a1');
      expect(threads[1].messages.length, 2);
      expect(threads[1].label, 'a1');
    });

    test('空内容行丢弃；非 Map result → 空列表', () {
      expect(
        parseSubagentThreads({
          'messages': [
            {
              'info': {'role': 'assistant'},
              'parts': [],
            },
          ],
        },).isEmpty,
        true,
      );
      expect(parseSubagentThreads(null).isEmpty, true);
    });
  });

  group('流事件 agent 归属透传', () {
    test('payload.agent → 事件 data.agent', () {
      final events = _payload({
        'kind': 'text_delta',
        'delta': 'hi',
        'agent': 'general-purpose',
      });
      expect(events.single.event, WsEvents.agentText);
      expect((events.single.data as Map)['agent'], 'general-purpose');
    });
  });
}

List<WsMessage> _payload(Map<String, dynamic> payload) =>
    translateNotification('session/event', {
      'sessionId': 's1',
      'events': [
        {'payload': payload},
      ],
    }, (_, __) {},);
