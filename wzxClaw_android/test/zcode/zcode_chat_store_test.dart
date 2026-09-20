// ============================================================
// zcode_chat_store_test — 状态层单元测试
//
// 用 FakeZcodeRelayClient（implements 公共 API）+ FakeZcodeNotifier
// 通过构造注入驱动；通知帧 / 反向请求用 @visibleForTesting 钩子注入。
//
// P1.2 同步层重构用例：推送渲染（subscribe + model.streaming +
// turn.completed 本地收尾）、工具回合增量权威刷新、epoch 乱串杜绝
// （A 流式中途切 B）、断线重订阅补放去重、SQLite 缓存重建恢复、
// 多会话并发（后台收尾）、模型不可用 setModel 兜底（字符串拒绝 +
// 错误帧 -32031 + resume 播种可用模型 + 历史污染提示新建会话）、
// resume messages 数组忽略。
// ============================================================

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:wzxclaw_android/models/chat_message.dart';
import 'package:wzxclaw_android/zcode/zcode_reverse_models.dart';
import 'package:wzxclaw_android/zcode/zcode_chat_store.dart';
import 'package:wzxclaw_android/zcode/zcode_notifier.dart';
import 'package:wzxclaw_android/zcode/zcode_relay_client.dart';
import 'package:wzxclaw_android/zcode/zcode_session_state.dart';
import 'zcode_test_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  tearDown(() {
    ZcodeNotifier.resetInstanceForTest();
  });

  group('会话', () {
    test('openSession：resume parts → ChatMessage 映射（tool 状态 + 截断提示）', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/resume'] = (_) => {
            'session': {
              'workspace': {'workspaceKey': 'k1', 'workspacePath': 'E:\\proj'},
            },
            'projection': {'status': 'idle'},
            'messagesTruncated': true,
            'messages': [
              fakeMsg(
                'user',
                [
                  {'type': 'text', 'text': '你好'},
                ],
                id: 'm1',
                created: 1000,
              ),
              fakeMsg(
                'assistant',
                [
                  {'type': 'text', 'text': '回答'},
                  {'type': 'reasoning', 'text': '思考过程'},
                  // 实测 tool part 形状：callID（大写 D）、tool 为字符串、
                  // input/output/error 嵌在 state 对象里
                  {
                    'type': 'tool',
                    'callID': 'tc-running',
                    'tool': 'FileRead',
                    'state': {
                      'status': 'running',
                      'input': {'path': 'a.txt'},
                    },
                  },
                  {
                    'type': 'tool',
                    'callID': 'tc-done',
                    'tool': 'ShellExecute',
                    'state': {
                      'status': 'completed',
                      'input': {'command': 'ls'},
                      'output': '文件列表',
                    },
                  },
                  {
                    'type': 'tool',
                    'callID': 'tc-failed',
                    'tool': 'Echo',
                    'state': {
                      'status': 'error',
                      'input': {},
                      'error': 'Permission request failed',
                    },
                  },
                ],
                id: 'm2',
                created: 2000,
                modelId: 'glm-5.3',
              ),
              fakeMsg('assistant', [], id: 'm3'), // 空 assistant → 过滤
            ],
          };
      final store = pairedStore(fake);

      await store.openSession('sess-1');
      expect(store.activeSessionId, 'sess-1');
      expect(store.messages.length, 3); // 截断提示 + user + assistant

      // 头部截断提示
      expect(store.messages.first.role, MessageRole.assistant);
      expect(store.messages.first.text, contains('已截断'));

      // user 消息
      expect(store.messages[1].role, MessageRole.user);
      expect(store.messages[1].text, '你好');

      // assistant 消息：原序 processParts（text/reasoning/tool + 状态映射）
      final a = store.messages[2];
      expect(a.text, '回答');
      expect(a.model, 'glm-5.3');
      expect(
        a.processParts.map((p) => p.kind),
        [
          ChatProcessPartKind.text,
          ChatProcessPartKind.reasoning,
          ChatProcessPartKind.tool,
          ChatProcessPartKind.tool,
          ChatProcessPartKind.tool,
        ],
      ); // reasoning 保留在原位，marker/工具不丢失
      final calls = a.processParts
          .where((p) => p.kind == ChatProcessPartKind.tool)
          .map((p) => p.toolCall!)
          .toList();
      expect(calls.length, 3);
      expect(calls[0].toolName, 'FileRead');
      expect(calls[0].toolCallId, 'tc-running'); // callID（大写 D）
      expect(calls[0].status, ToolCallStatus.running);
      expect(calls[1].toolName, 'ShellExecute');
      expect(calls[1].status, ToolCallStatus.done);
      expect(calls[1].outputSummary, '文件列表'); // state.output
      expect(calls[2].toolName, 'Echo'); // tool 为字符串的形态
      expect(calls[2].status, ToolCallStatus.error);
      expect(calls[2].isError, isTrue);
      expect(
        calls[2].outputSummary,
        'Permission request failed',
      ); // state.error 优先展示

      expect(store.isStreaming, isFalse);
      final resume = fake.requests.firstWhere((e) => e.key == 'session/resume');
      expect(resume.value, {'sessionId': 'sess-1'});
    });

    test('openSession：projection running → isStreaming 并启动轮询', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/resume'] = (_) => {
            'projection': {'status': 'running'},
            'messages': [],
          };
      fake.handlers['session/events'] = (_) => {'events': []};
      final store = pairedStore(fake);

      await store.openSession('sess-r');
      expect(store.isStreaming, isTrue);

      // 清理轮询计时器
      store.closeSessionView();
      expect(store.activeSessionId, isNull);
      expect(store.isStreaming, isFalse);
    });
  });

  group('聊天', () {
    test('sendMessage：本地 user 消息 + 流式 assistant 占位 + 请求参数', () async {
      final fake = FakeZcodeRelayClient();
      stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) => {'accepted': true};
      fake.handlers['session/events'] = (_) => {'events': []};
      final store = pairedStore(fake);
      await store.openSession('sess-1');

      await store.sendMessage('你好，帮我看看');
      final msgs = store.messages;
      expect(msgs.length, 2);
      expect(msgs[0].role, MessageRole.user);
      expect(msgs[0].text, '你好，帮我看看');
      expect(msgs[1].role, MessageRole.assistant);
      expect(msgs[1].isStreaming, isTrue);
      expect(store.isStreaming, isTrue);
      expect(store.isWaitingForResponse, isTrue);
      expect(store.error, isNull);

      final send = fake.requests.firstWhere((e) => e.key == 'session/send');
      expect(send.value, {'sessionId': 'sess-1', 'content': '你好，帮我看看'});

      store.dispose();
    });

    test('sendMessage：请求异常 → error 状态且不启动轮询', () async {
      final fake = FakeZcodeRelayClient();
      stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) =>
          throw const ZcodeRequestException(-32004, 'Session is not active');
      final store = pairedStore(fake);
      await store.openSession('sess-1');

      await store.sendMessage('hi');
      expect(store.error, contains('发送失败'));
      expect(store.isStreaming, isFalse);
      expect(store.isWaitingForResponse, isFalse);
      // 占位被终结（isStreaming=false）
      expect(store.messages.last.isStreaming, isFalse);
      // 未启动轮询：没有 session/events 请求
      expect(fake.requests.any((e) => e.key == 'session/events'), isFalse);
    });

    test('流式轮询：text_delta/reasoning_delta 追加，按 eventId 去重', () async {
      final fake = FakeZcodeRelayClient();
      stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) => {'accepted': true};
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'e1',
                'payload': {'kind': 'reasoning_delta', 'delta': '想想'},
              },
              {
                'eventId': 'e2',
                'payload': {'kind': 'text_delta', 'delta': 'Hel'},
              },
            ],
          };
      final store = pairedStore(fake);
      await store.openSession('sess-s');

      await store.sendMessage('hi');
      // sendMessage 成功后的首个 tick 立即应用
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(store.messages.last.text, 'Hel');
      expect(store.messages.last.isStreaming, isTrue);
      expect(store.liveThinkingText, '想想');
      expect(store.isWaitingForResponse, isFalse); // 首个增量已到达

      // 第二拍：重复的 e2 应被去重，新增 e3 追加
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'e2',
                'payload': {'kind': 'text_delta', 'delta': 'Hel'},
              },
              {
                'eventId': 'e3',
                'payload': {'kind': 'text_delta', 'delta': 'lo'},
              },
            ],
          };
      await store.debugPollOnce();
      await Future<void>.delayed(Duration.zero);
      expect(store.messages.last.text, 'Hello'); // 'Hel' 只计一次 + 'lo'

      store.dispose();
    });

    test('state.updated：running/idle 切换 isStreaming', () async {
      final fake = FakeZcodeRelayClient();
      stubResumeEmpty(fake);
      final store = pairedStore(fake);
      await store.openSession('sess-1');

      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'patch': {'status': 'running'},
          },
        ),
      );
      expect(store.isStreaming, isTrue);

      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'patch': {'status': 'idle'},
          },
        ),
      );
      expect(store.isStreaming, isFalse);
    });

    test('turn.terminal：停轮询 + 任务完成通知 + 权威刷新（含工具结果）', () async {
      final fake = FakeZcodeRelayClient();
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      stubResumeEmpty(fake);
      fake.handlers['session/send'] = (_) => {'accepted': true};
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'e1',
                'payload': {'kind': 'text_delta', 'delta': '部分回答'},
              },
            ],
          };
      final store = pairedStore(fake);
      await store.openSession('sess-t');
      await store.sendMessage('go');
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(store.messages.last.text, '部分回答');

      // token 用量通知
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'v4/telemetry/event',
          params: {
            'kind': 'usage.delta',
            'inputTokens': 12,
            'outputTokens': 34,
          },
        ),
      );

      // 权威消息（含工具调用结果，只有权威列表才有；实测 tool part 形状）
      fake.handlers['session/messages'] = (_) => {
            'messages': [
              fakeMsg(
                'user',
                [
                  {'type': 'text', 'text': 'go'},
                ],
                id: 'a1',
                created: 1,
              ),
              fakeMsg(
                'assistant',
                [
                  {'type': 'text', 'text': '最终回答'},
                  {
                    'type': 'tool',
                    'callID': 'tc9',
                    'tool': 'FileWrite',
                    'state': {
                      'status': 'completed',
                      'input': {'path': 'x.txt'},
                      'output': '写入 3 行',
                    },
                  },
                ],
                id: 'a2',
                created: 2,
              ),
            ],
          };

      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'v4/telemetry/event',
          params: {
            'kind': 'turn.terminal',
            'status': 'success',
            'tokenCount': 34,
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 通知回调
      expect(notifier.shown.length, 1);
      expect(notifier.shown.first['status'], 'success');
      expect(notifier.shown.first['tokens'], 34);
      expect(notifier.shown.first['sessionId'], 'sess-t');

      // 权威刷新重建消息
      expect(store.messages.length, 2);
      expect(store.messages.last.text, '最终回答');
      final tc = store.messages.last.processParts
          .firstWhere((p) => p.kind == ChatProcessPartKind.tool)
          .toolCall!;
      expect(tc.toolCallId, 'tc9');
      expect(tc.toolName, 'FileWrite');
      expect(tc.status, ToolCallStatus.done);
      expect(tc.outputSummary, '写入 3 行');
      expect(store.isStreaming, isFalse);
      expect(store.isWaitingForResponse, isFalse);

      // turn.terminal 已停轮询：不再产生 session/events 请求
      final eventsCount =
          fake.requests.where((e) => e.key == 'session/events').length;
      expect(eventsCount, greaterThanOrEqualTo(1));
      await Future<void>.delayed(Duration.zero);
      expect(
        fake.requests.where((e) => e.key == 'session/events').length,
        eventsCount,
      );
    });

    test('stopGeneration：session/stop + 增量权威刷新', () async {
      final fake = FakeZcodeRelayClient();
      stubResumeEmpty(fake);
      fake.handlers['session/events'] = (_) => {'events': []};
      // 状态化服务端：send 落库新消息；messages 按 afterMessageId 增量返回
      final serverMessages = <Map<String, dynamic>>[
        fakeMsg(
          'user',
          [
            {'type': 'text', 'text': '旧问题'},
          ],
          id: 'b0',
          created: 1,
        ),
        fakeMsg(
          'assistant',
          [
            {'type': 'text', 'text': '旧回答'},
          ],
          id: 'b1',
          created: 2,
        ),
      ];
      fake.handlers['session/send'] = (_) {
        serverMessages.add(
          fakeMsg(
            'user',
            [
              {'type': 'text', 'text': 'go'},
            ],
            id: 'u1',
            created: 3,
          ),
        );
        return {'accepted': true};
      };
      fake.handlers['session/stop'] = (_) {
        // 停止时服务端持久化被中止的 assistant 回复
        serverMessages.add(
          fakeMsg(
            'assistant',
            [
              {'type': 'text', 'text': '被中止的回答'},
            ],
            id: 'a1',
            created: 4,
          ),
        );
        return {};
      };
      fake.handlers['session/messages'] = (params) {
        final after = params?['afterMessageId'] as String?;
        if (after == null) return {'messages': List.of(serverMessages)};
        final idx = serverMessages.indexWhere((m) => m['info']['id'] == after);
        return {
          'messages': idx < 0
              ? List.of(serverMessages)
              : serverMessages.sublist(idx + 1),
        };
      };
      final store = pairedStore(fake);
      await store.openSession('sess-stop');
      expect(store.messages.length, 2); // 打开时拉到最近窗口
      await store.sendMessage('go');

      await store.stopGeneration();
      expect(fake.requests.any((e) => e.key == 'session/stop'), isTrue);
      final stop = fake.requests.firstWhere((e) => e.key == 'session/stop');
      expect(stop.value, {'sessionId': 'sess-stop'});
      // 增量刷新只拉新增（afterMessageId = b1），乐观 user 消息被原位消解
      final refresh =
          fake.requests.lastWhere((e) => e.key == 'session/messages').value;
      expect(refresh!['afterMessageId'], 'b1');
      expect(store.messages.length, 4); // 旧窗口 2 条 + 本回合 2 条
      expect(store.messages.where((m) => m.text == 'go'), hasLength(1));
      expect(store.messages.last.text, '被中止的回答');
      expect(store.isStreaming, isFalse);
    });
  });

  group('newSession', () {
    test('复用 sessions 里第一个有 workspace 的条目并打开新会话', () async {
      final fake = FakeZcodeRelayClient();
      final sessions = <Map<String, dynamic>>[
        {'sessionId': 's2', 'title': '', 'updatedAt': 9}, // 无 workspace → 跳过
        {
          'sessionId': 's1',
          'title': '最近的会话',
          'updatedAt': 5,
          'workspace': {
            'workspaceKey': 'wk1',
            'workspacePath': 'E:/ai/wzxClaw',
          },
        },
      ];
      fake.handlers['session/list'] = (_) => {'sessions': sessions};
      fake.handlers['session/create'] = (_) {
        sessions.insert(0, {
          'sessionId': 's-new',
          'title': '新会话',
          'updatedAt': 99,
          'workspace': {
            'workspaceKey': 'wk1',
            'workspacePath': 'E:/ai/wzxClaw',
          },
        });
        return {
          'session': {'sessionId': 's-new'},
        };
      };
      stubResumeEmpty(fake);
      final store = pairedStore(fake);

      await store.refreshSessions();
      expect(store.sessions.length, 2);
      expect(store.sessions.first.sessionId, 's2'); // 列表顺序保持
      expect(store.sessions[1].workspaceKey, 'wk1');
      expect(store.sessions[1].title, '最近的会话');

      await store.newSession();
      final create = fake.requests.firstWhere((e) => e.key == 'session/create');
      expect(create.value, {
        'workspace': {'workspaceKey': 'wk1', 'workspacePath': 'E:/ai/wzxClaw'},
      });
      expect(store.activeSessionId, 's-new');
      final resume = fake.requests.lastWhere((e) => e.key == 'session/resume');
      expect(resume.value, {'sessionId': 's-new'});
      // create 后刷新过列表：新会话出现在列表里
      expect(store.sessions.any((s) => s.sessionId == 's-new'), isTrue);
    });

    test('无可用工作区 → error 提示', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/list'] = (_) => {
            'sessions': [
              {'sessionId': 's0', 'title': 'x', 'updatedAt': 1},
            ],
          };
      final store = pairedStore(fake);

      await store.newSession();
      expect(store.error, contains('工作区'));
      expect(store.activeSessionId, isNull);
    });

    test('显式指定 workspace（抽屉分组头"+"）优先于复用默认', () async {
      final fake = FakeZcodeRelayClient();
      final sessions = <Map<String, dynamic>>[
        {
          'sessionId': 's1',
          'title': '最近的会话',
          'updatedAt': 5,
          'workspace': {
            'workspaceKey': 'wk1',
            'workspacePath': 'E:/ai/wzxClaw',
          },
        },
      ];
      fake.handlers['session/list'] = (_) => {'sessions': sessions};
      fake.handlers['session/create'] = (_) {
        sessions.insert(0, {
          'sessionId': 's-ws2',
          'title': '',
          'updatedAt': 100,
          'workspace': {'workspaceKey': 'wk2', 'workspacePath': 'D:/duanju'},
        });
        return {
          'session': {'sessionId': 's-ws2'},
        };
      };
      stubResumeEmpty(fake);
      final store = pairedStore(fake);

      await store.refreshSessions();
      // 列表里最近的是 wk1，但显式指定 wk2 必须优先生效
      await store.newSession(workspaceKey: 'wk2', workspacePath: 'D:/duanju');
      final create = fake.requests.firstWhere((e) => e.key == 'session/create');
      expect(create.value, {
        'workspace': {'workspaceKey': 'wk2', 'workspacePath': 'D:/duanju'},
      });
      expect(store.activeSessionId, 's-ws2');
    });
  });

  group('权限确认 / AskUser（反向请求）', () {
    test('权限反向请求（实测形状）→ 流事件 + 应答回放 option response 原文', () async {
      final fake = FakeZcodeRelayClient();
      final store = pairedStore(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);

      final events = <PermissionRequest?>[];
      final sub = store.permissionStream.listen(events.add);

      // 实测形状（probe-toolturn，APP-SERVER.md「工具回合实测」）：
      // method=interaction/requestPermission；options 携带各选项的 response
      final future = store.debugHandleReverseRequest(
        const ZcodeFrame(
          id: 'server-1',
          method: 'interaction/requestPermission',
          params: {
            'input': {
              'command': "printf 'A' > probe-a.txt",
              'description': 'Write A to probe-a.txt',
            },
            'reason': 'High risk tools require explicit approval',
            'requestId': 'perm_04189f93-0000-0000-0000-000000000001',
            'riskLevel': 'high',
            'sessionId': 'sess-x',
            'options': [
              {
                'kind': 'allow_once',
                'optionId': 'allow_once',
                'name': 'Allow once',
                'response': {'decision': 'allow', 'reason': 'Approved once'},
              },
              {
                'kind': 'allow_always',
                'optionId': 'allow_project',
                'name': 'Always allow in this project',
                'response': {
                  'decision': 'allow',
                  'permissionUpdates': [
                    {
                      'behavior': 'allow',
                      'rules': [
                        {
                          'ruleContent': "printf 'A' > probe-a.txt",
                          'toolName': 'Bash',
                        },
                      ],
                      'type': 'addRules',
                    },
                  ],
                  'reason': 'Approved for this project',
                },
              },
              {
                'kind': 'deny',
                'optionId': 'deny',
                'name': 'Deny',
                'response': {'decision': 'deny', 'reason': 'Denied'},
              },
            ],
            'toolCallId': 'call_tc1',
            'toolName': 'Bash',
            'turnId': 'turn_1',
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission?.toolCallId, 'call_tc1');
      expect(store.activePermission?.toolName, 'Bash');
      expect(store.activePermission?.input, {
        'command': "printf 'A' > probe-a.txt",
        'description': 'Write A to probe-a.txt',
      });
      expect(events, hasLength(1));
      expect(events.first?.toolCallId, 'call_tc1');
      // 后台通知：任务挂起等人批准，权限请求到达即提醒（摘要 = 工具名）
      expect(notifier.reverseRequests, [
        {'isAskUser': false, 'summary': 'Bash'},
      ]);

      // 批准 + remember：回放 allow_project 选项的 response 原文
      // （含 permissionUpdates——只有请求方知道其内容）
      store.respondToPermission('call_tc1', approved: true, remember: true);
      expect(await future, {
        'decision': 'allow',
        'permissionUpdates': [
          {
            'behavior': 'allow',
            'rules': [
              {'ruleContent': "printf 'A' > probe-a.txt", 'toolName': 'Bash'},
            ],
            'type': 'addRules',
          },
        ],
        'reason': 'Approved for this project',
      });
      expect(store.activePermission, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(events, hasLength(2)); // 清空事件
      expect(events.last, isNull);

      // 一次性批准：回放 allow_once 的 response 原文
      final futureOnce = store.debugHandleReverseRequest(
        const ZcodeFrame(
          id: 'server-2',
          method: 'interaction/requestPermission',
          params: {
            'input': {'command': 'echo hi'},
            'toolCallId': 'call_tc2',
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
        ),
      );
      await Future<void>.delayed(Duration.zero);
      store.respondToPermission('call_tc2', approved: true);
      expect(
        await futureOnce,
        {'decision': 'allow', 'reason': 'Approved once'},
      );

      // 拒绝：回放 deny 选项的 response 原文
      final futureDeny = store.debugHandleReverseRequest(
        const ZcodeFrame(
          id: 'server-3',
          method: 'interaction/requestPermission',
          params: {
            'input': {'command': 'rm -rf /'},
            'toolCallId': 'call_tc3',
            'toolName': 'Bash',
            'options': [
              {
                'optionId': 'deny',
                'response': {'decision': 'deny', 'reason': 'Denied'},
              },
            ],
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);
      store.respondToPermission('call_tc3', approved: false);
      expect(await futureDeny, {'decision': 'deny', 'reason': 'Denied'});

      // 无 options 暂存（协议漂移兜底）：按实测 schema 构造最小 result
      final futureFallback = store.debugHandleReverseRequest(
        const ZcodeFrame(
          id: 'server-4',
          method: 'interaction/requestPermission',
          params: {
            'toolCallId': 'call_tc4',
            'toolName': 'FileWrite',
            'input': {},
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);
      store.respondToPermission('call_tc4', approved: false);
      expect(await futureFallback, {'decision': 'deny', 'reason': 'Denied'});

      // 重复应答（已清除）静默忽略
      store.respondToPermission('call_tc4', approved: true);
      sub.cancel();
    });

    test('snake_case 字段兜底：旧形态仍可解析并按兜底 schema 应答', () async {
      final fake = FakeZcodeRelayClient();
      final store = pairedStore(fake);

      final future = store.debugHandleReverseRequest(
        const ZcodeFrame(
          id: 'server-5',
          method: 'interaction/requestPermission',
          params: {'tool_call_id': 'tc-2', 'tool_name': 'ShellExecute'},
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission?.toolCallId, 'tc-2');
      expect(store.activePermission?.toolName, 'ShellExecute');
      store.respondToPermission('tc-2', approved: false);
      expect(await future, {'decision': 'deny', 'reason': 'Denied'});
    });

    test('AskUser 反向请求 → 流事件 + 应答回传选项', () async {
      final fake = FakeZcodeRelayClient();
      final store = pairedStore(fake);

      final events = <AskUserQuestion?>[];
      final sub = store.askUserStream.listen(events.add);

      final future = store.debugHandleReverseRequest(
        const ZcodeFrame(
          id: 'server-3',
          method: 'interaction/askUser',
          params: {
            'questionId': 'q-1',
            'question': '选哪个？',
            'options': [
              {'label': 'A', 'description': '选项A'},
              {'label': 'B', 'description': '选项B'},
            ],
            'multiSelect': false,
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(store.activeAskUser?.questionId, 'q-1');
      expect(store.activeAskUser?.question, '选哪个？');
      expect(store.activeAskUser!.options.length, 2);
      expect(store.activeAskUser!.options.first['label'], 'A');
      expect(events, hasLength(1));

      store.respondToAskUser('q-1', ['A'], customText: '备注');
      expect(await future, {
        'questionId': 'q-1',
        'selectedLabels': ['A'],
        'customText': '备注',
      });
      expect(store.activeAskUser, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(events.last, isNull);
      sub.cancel();
    });

    test('解析失败 / 未知 method → 抛错（默认安全拒绝）', () async {
      final fake = FakeZcodeRelayClient();
      final store = pairedStore(fake);

      // method 含 interaction 但形状不符（缺 question/options）
      expect(
        () => store.debugHandleReverseRequest(
          const ZcodeFrame(
            id: 'server-4',
            method: 'interaction/prompt',
            params: {'foo': 1},
          ),
        ),
        throwsA(isA<Exception>()),
      );
      // 权限请求缺关键字段
      expect(
        () => store.debugHandleReverseRequest(
          const ZcodeFrame(
            id: 'server-5',
            method: 'interaction/requestPermission',
            params: {'input': {}},
          ),
        ),
        throwsA(isA<Exception>()),
      );
      // 完全未知的反向请求
      expect(
        () => store.debugHandleReverseRequest(
          const ZcodeFrame(
            id: 'server-6',
            method: 'workspace/open',
            params: {},
          ),
        ),
        throwsA(isA<Exception>()),
      );
      expect(store.activePermission, isNull);
      expect(store.activeAskUser, isNull);
    });

    test('unpair：挂起的反向请求以 error 帧拒绝收尾（安全拒绝）', () async {
      final fake = FakeZcodeRelayClient();
      final store = pairedStore(fake);

      final future = store.debugHandleReverseRequest(
        const ZcodeFrame(
          id: 'server-7',
          method: 'interaction/requestPermission',
          params: {'toolCallId': 'tc-x', 'toolName': 'FileRead'},
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission, isNotNull);

      // 先挂错误断言再触发拒绝，避免 unhandled async error
      final done = expectLater(
        future,
        throwsA(isA<ZcodeReverseRejectException>()),
      );
      store.dispose();
      await done;
      expect(store.activePermission, isNull);
    });

    test('断线：在途权限请求立即作废——权限条清除、应答拒绝、迟到批准无效果', () async {
      final fake = FakeZcodeRelayClient();
      final store = pairedStore(fake);

      final events = <PermissionRequest?>[];
      final sub = store.permissionStream.listen(events.add);
      addTearDown(sub.cancel);

      final future = store.debugHandleReverseRequest(
        const ZcodeFrame(
          id: 'server-9',
          method: 'interaction/requestPermission',
          params: {
            'input': {'command': 'echo hi'},
            'toolCallId': 'call_dc1',
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
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(store.activePermission?.toolCallId, 'call_dc1');

      // 断线（重连中/被顶号）：server-N id 将被新连接复用，
      // 在途请求必须立即作废，权限条同步清除
      final done = expectLater(
        future,
        throwsA(isA<ZcodeReverseRejectException>()),
      );
      store.debugSimulateRelayState(ZcodeRelayState.closed, false);
      await done;

      expect(store.activePermission, isNull);
      await Future<void>.delayed(Duration.zero);
      expect(events.last, isNull); // 权限条流被清空

      // 此刻迟到的"批准"是无害 no-op：不再产生任何应答
      expect(
        () => store.respondToPermission('call_dc1', approved: true),
        returnsNormally,
      );
    });
  });

  group('模型选择器（settings.model 快照目录 + setModel）', () {
    test('resume 快照播种模型目录与当前模型；setModel 走对象参数', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/resume'] = (_) => {
            'projection': {'status': 'idle'},
            'messages': [],
            'settings': {
              'model': {
                'current': {
                  'providerId': 'builtin:bigmodel-coding-plan',
                  'modelId': 'glm-5.3',
                },
                'available': [
                  {
                    'ref': {
                      'providerId': 'builtin:bigmodel-coding-plan',
                      'modelId': 'glm-5.3',
                    },
                    'label': 'GLM-5.3',
                    'contextWindow': 200000,
                    'maxOutputTokens': 128000,
                    // 引擎实测形状：levels 每项 {value,label}，defaultLevel 直取
                    'reasoning': {
                      'levels': [
                        {'value': 'high', 'label': 'high'},
                        {'value': 'max', 'label': 'max'},
                      ],
                      'defaultLevel': 'high',
                    },
                    'providerLabel': 'BigModel',
                  },
                  {
                    'ref': {
                      'providerId': 'builtin:bigmodel-coding-plan',
                      'modelId': 'glm-5.3-flash',
                    },
                    'label': 'GLM-5.3-Flash',
                  },
                ],
              },
            },
          };
      final setModelParams = <Map<String, dynamic>?>[];
      fake.handlers['session/setModel'] = (params) {
        setModelParams.add(params);
        return {'ok': true};
      };
      final store = pairedStore(fake);

      await store.openSession('sess-m');
      expect(store.modelCatalog.length, 2);
      expect(store.modelCatalog.first.displayName, 'GLM-5.3');
      // reasoning 映射（实测形状 {levels:[{value,label}], defaultLevel}）
      expect(store.modelCatalog.first.reasoningLevels, ['high', 'max']);
      expect(store.modelCatalog.first.reasoningDefaultLevel, 'high');
      expect(store.modelCatalog.first.reasoningLevelForRequest, 'high');
      expect(store.modelCatalog.last.reasoningLevels, isEmpty);
      expect(store.modelCatalog.last.reasoningLevelForRequest, isNull);
      expect(store.modelCatalog.first.contextWindow, 200000);
      expect(
        store.modelCatalog.first.ref,
        'builtin:bigmodel-coding-plan/glm-5.3',
      );
      expect(store.currentModelRef, 'builtin:bigmodel-coding-plan/glm-5.3');

      final ok = await store.setModel(
        'builtin:bigmodel-coding-plan',
        'glm-5.3-flash',
      );
      expect(ok, isTrue);
      // 无档位模型：不带 options（实测契约允许缺省）
      expect(setModelParams.single, {
        'sessionId': 'sess-m',
        'model': {
          'providerId': 'builtin:bigmodel-coding-plan',
          'modelId': 'glm-5.3-flash',
        },
      });
      // 乐观回填当前模型
      expect(
        store.currentModelRef,
        'builtin:bigmodel-coding-plan/glm-5.3-flash',
      );
    });

    test('setModel 带推理档位：imported 模型必填 options.reasoningLevel', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/resume'] = (_) => {
            'projection': {'status': 'idle'},
            'messages': [],
            'settings': {
              'model': {
                'available': [
                  {
                    // imported 形状：providerId 带导入哈希，reasoning 必填
                    'ref': {'providerId': 'imported:codex:abc123', 'modelId': 'gpt-5.6-sol'},
                    'label': 'GPT-5.6 Sol',
                    'reasoning': {
                      'levels': [
                        {'value': 'low', 'label': 'low'},
                        {'value': 'high', 'label': 'high'},
                      ],
                      'defaultLevel': 'high',
                    },
                  },
                ],
              },
            },
          };
      final setModelParams = <Map<String, dynamic>?>[];
      fake.handlers['session/setModel'] = (params) {
        setModelParams.add(params);
        return {'ok': true};
      };
      final store = pairedStore(fake);

      await store.openSession('sess-imported');
      final ok = await store.setModel(
        'imported:codex:abc123',
        'gpt-5.6-sol',
        reasoningLevel: 'high',
      );
      expect(ok, isTrue);
      expect(setModelParams.single, {
        'sessionId': 'sess-imported',
        'model': {
          'providerId': 'imported:codex:abc123',
          'modelId': 'gpt-5.6-sol',
          'options': {'reasoningLevel': 'high'},
        },
      });
    });

    test('applySessionModel：对非视口会话应用模型（建会后应用默认的入口）',
        () async {
      final fake = FakeZcodeRelayClient();
      final setModelParams = <Map<String, dynamic>?>[];
      fake.handlers['session/setModel'] = (params) {
        setModelParams.add(params);
        return {'ok': true};
      };
      final store = pairedStore(fake);
      // 不 openSession：applySessionModel 不依赖当前视口

      await store.applySessionModel(
        'sess-new',
        providerId: 'imported:codex:abc123',
        modelId: 'gpt-5.6-sol',
        reasoningLevel: 'high',
      );
      expect(setModelParams.single, {
        'sessionId': 'sess-new',
        'model': {
          'providerId': 'imported:codex:abc123',
          'modelId': 'gpt-5.6-sol',
          'options': {'reasoningLevel': 'high'},
        },
      });
    });

    test('tool_input_delta 累积：分片拼接成完整输入，全量到达后清缓冲',
        () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('sess-delta');
      var seq = 0;
      void push(String kind, Map<String, dynamic> payload) {
        seq++;
        pushEvent(
          store,
          sessionId: 'sess-delta',
          type: 'model.streaming',
          seq: seq,
          turnId: 'turn-d',
          payload: {...payload, 'kind': kind},
        );
      }

      ToolCallInfo toolById() => store.messages
          .expand((m) => m.processParts)
          .map((p) => p.toolCall)
          .whereType<ToolCallInfo>()
          .firstWhere((t) => t.toolCallId == 'call-d1');

      push('tool_input_start', {
        'toolCallId': 'call-d1', 'toolName': 'Bash', 'assistantMessageId': 'msg-d1',
      });
      push('tool_input_delta', {'toolCallId': 'call-d1', 'delta': '{"comm'});
      push('tool_input_delta', {'toolCallId': 'call-d1', 'delta': 'and":"npm test"}'});
      expect(toolById().inputFull, '{"command":"npm test"}');

      // 累计快照形态：新分片以前缀包含旧累积时替换而非重复拼接
      push('tool_input_delta', {
        'toolCallId': 'call-d1', 'delta': '{"command":"npm test"} {"extra":1}',
      });
      expect(toolById().inputFull, '{"command":"npm test"} {"extra":1}');

      // 全量到达（tool_call 带 input）：权威输入替换
      push('tool_call', {
        'toolCallId': 'call-d1',
        'input': {'command': 'npm test'},
      });
      expect(toolById().inputFull, '{"command":"npm test"}');
      expect(seq, greaterThan(0));
    });

    test('未打开会话时 setModel 失败并置 error', () async {
      final fake = FakeZcodeRelayClient();
      final store = pairedStore(fake);
      final ok = await store.setModel('p', 'm');
      expect(ok, isFalse);
      expect(store.error, isNotNull);
    });
  });

  group('桌面端占用中的会话（-32004）', () {
    test('resume -32004：保留视口、置 remoteActiveElsewhere、错误文案明确', () async {
      final fake = FakeZcodeRelayClient();
      fake.handlers['session/resume'] = (_) =>
          throw const ZcodeRequestException(-32004, 'Session is not active');
      final store = pairedStore(fake);

      await store.openSession('sess-live');
      expect(store.remoteActiveElsewhere, isTrue);
      expect(store.activeSessionId, 'sess-live'); // 视口保留，不回列表
      expect(store.error, contains('桌面端运行'));
    });
  });

  group('同步层重构（P1.2）', () {
    test('单例：生产无参构造固定返回 app 作用域实例', () {
      final a = ZcodeChatStore();
      final b = ZcodeChatStore();
      expect(a, same(ZcodeChatStore.instance));
      expect(b, same(a));
    });

    test('视口加载：忽略 resume 的 messages 数组，以 session/messages 尾窗为准', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      // resume 响应携带陈旧消息（新路径应忽略），尾窗接口返回最新内容
      fake.handlers['session/resume'] = (_) => {
            'projection': {'status': 'idle'},
            'messages': [
              fakeMsg(
                'user',
                [
                  {'type': 'text', 'text': '陈旧消息'},
                ],
                id: 'stale-1',
                created: 1,
              ),
            ],
          };
      server.session('sess-v').messages.add(
            fakeMsg(
              'assistant',
              [
                {'type': 'text', 'text': '最新回答'},
              ],
              id: 'fresh-1',
              created: 2,
            ),
          );
      final store = pairedStore(fake);

      await store.openSession('sess-v');
      expect(store.messages.map((m) => m.text), isNot(contains('陈旧消息')));
      expect(store.messages.single.text, '最新回答');
    });

    test('尾窗请求带 limit:40，替身按实测契约只回最新 N 条升序', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      // 50 条服务端消息：尾窗只应取回最新 40 条（m10..m49，升序）
      for (var i = 0; i < 50; i++) {
        server.session('sess-big').messages.add(
              fakeMsg(
                i.isEven ? 'user' : 'assistant',
                [
                  {'type': 'text', 'text': 'm$i'},
                ],
                id: 'm$i',
                created: i,
              ),
            );
      }
      final store = pairedStore(fake);

      await store.openSession('sess-big');
      final req = fake.requests.firstWhere((e) => e.key == 'session/messages');
      expect(req.value!['limit'], 40);
      expect(req.value!['afterMessageId'], isNull);
      expect(store.messages, hasLength(40));
      expect(store.messages.first.text, 'm10');
      expect(store.messages.last.text, 'm49');
    });

    test('分页方向（实测升序）：升序页直通；降序页被投票兜底翻转', () async {
      // 实测（probe-sync3）：session/messages 一律升序（旧→新）返回，
      // 正常路径直通；若服务端漂移返回降序页，投票兜底应翻转为升序展示。
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('sess-asc').messages.addAll(
        [
          fakeMsg(
            'user',
            [
              {'type': 'text', 'text': '最早'},
            ],
            id: 'p1',
            created: 1,
          ),
          fakeMsg(
            'assistant',
            [
              {'type': 'text', 'text': '中间'},
            ],
            id: 'p2',
            created: 2,
          ),
          fakeMsg(
            'assistant',
            [
              {'type': 'text', 'text': '最新'},
            ],
            id: 'p3',
            created: 3,
          ),
        ],
      );
      final store = pairedStore(fake);
      await store.openSession('sess-asc');
      // 升序服务端页：直通展示（旧→新）
      expect(store.messages.map((m) => m.text), ['最早', '中间', '最新']);

      // 降序服务端页（异常兜底）：翻转为旧→新
      fake.handlers['session/messages'] = (_) => {
            'messages': [
              fakeMsg(
                'assistant',
                [
                  {'type': 'text', 'text': '新'},
                ],
                id: 'q2',
                created: 20,
              ),
              fakeMsg(
                'user',
                [
                  {'type': 'text', 'text': '旧'},
                ],
                id: 'q1',
                created: 10,
              ),
            ],
          };
      final store2 = pairedStore(fake);
      await store2.openSession('sess-desc');
      expect(store2.messages.map((m) => m.text), ['旧', '新']);
    });

    test('推送渲染：model.streaming 增量直渲染；turn.completed 纯文本本地收尾免权威刷新', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = pairedStore(fake);
      await store.openSession('sess-p');

      // 订阅在 materialize 时建立（web-remote-replayable）
      final sub = fake.requests.firstWhere((e) => e.key == 'session/subscribe');
      expect(sub.value, {
        'sessionId': 'sess-p',
        'deliveryKind': 'web-remote-replayable',
      });
      expect(server.session('sess-p').subscribeCalls, 1);

      await store.sendMessage('hi');
      var seq = 0;
      void push(String type, Map<String, dynamic> payload) {
        seq++;
        pushEvent(
          store,
          sessionId: 'sess-p',
          type: type,
          seq: seq,
          turnId: 'turn-1',
          payload: payload,
        );
      }

      push('turn.started', {'messageId': 'srv-u-x', 'input': 'hi'});
      // 乐观 user 消息被 turn.started 采纳 protoId，不重复
      expect(
        store.messages.where((m) => m.role == MessageRole.user),
        hasLength(1),
      );

      push('model.streaming', {
        'assistantMessageId': 'msg-a1',
        'delta': 'Hel',
        'kind': 'text_delta',
        'done': false,
      });
      expect(store.messages.last.text, 'Hel');
      expect(store.messages.last.isStreaming, isTrue);

      push('model.streaming', {
        'assistantMessageId': 'msg-a1',
        'delta': 'lo',
        'kind': 'text_delta',
        'done': false,
      });
      expect(store.messages.last.text, 'Hello');

      // model.response 权威全文重对（防增量丢失）
      push('model.response', {'content': 'Hello'});
      expect(store.messages.last.text, 'Hello');

      final messagesReqsBefore =
          fake.requests.where((e) => e.key == 'session/messages').length;
      push('turn.completed', {
        'response': 'Hello',
        'tokenCount': 42,
        'toolCallCount': 0,
        'resultType': 'success',
        'usage': {'inputTokens': 40, 'outputTokens': 2},
      });
      expect(store.messages.last.text, 'Hello');
      expect(store.messages.last.isStreaming, isFalse);
      expect(store.messages.last.usage?.outputTokens, 2);
      expect(store.isStreaming, isFalse);
      expect(store.isWaitingForResponse, isFalse);
      // 每个完成回合都做增量权威刷新（P1 修复）：纯文本也不例外——
      // persist 只收 synced，跳过刷新 = 最新问答永远进不了 SQLite，
      // 离线重开即丢
      expect(
        fake.requests.where((e) => e.key == 'session/messages').length,
        greaterThan(messagesReqsBefore),
      );
      // 任务完成通知
      expect(notifier.shown.single['status'], 'success');
      expect(notifier.shown.single['tokens'], 42);
      expect(notifier.shown.single['sessionId'], 'sess-p');
      // 推送可用：全程无降级轮询
      expect(fake.requests.any((e) => e.key == 'session/events'), isFalse);
    });

    test('工具回合：turn.completed(toolCallCount>0) 走增量权威刷新（afterMessageId 水位）',
        () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      // 预置历史形成水位
      server.session('sess-t').messages.add(
            fakeMsg(
              'user',
              [
                {'type': 'text', 'text': '旧问题'},
              ],
              id: 'h1',
              created: 1,
            ),
          );
      final store = pairedStore(fake);
      await store.openSession('sess-t');
      expect(store.messages, hasLength(1)); // 打开时拉到尾窗

      await store.sendMessage('写文件');
      pushEvent(
        store,
        sessionId: 'sess-t',
        type: 'model.streaming',
        seq: 1,
        turnId: 'turn-t',
        payload: {
          'assistantMessageId': 'msg-a2',
          'delta': '正在写',
          'kind': 'text_delta',
        },
      );
      // 服务端回合落库（user 已由 send 落库；assistant 带工具结果）
      server.session('sess-t').messages.add(
            fakeMsg(
              'assistant',
              [
                {'type': 'text', 'text': '写完了'},
                {
                  'type': 'tool',
                  'callID': 'tc1',
                  'tool': 'FileWrite',
                  'state': {'status': 'completed', 'output': '写入 3 行'},
                },
              ],
              id: 'msg-a2',
              created: 2,
            ),
          );
      pushEvent(
        store,
        sessionId: 'sess-t',
        type: 'turn.completed',
        seq: 2,
        turnId: 'turn-t',
        payload: {
          'response': '写完了',
          'toolCallCount': 1,
          'resultType': 'success',
        },
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 增量刷新：只拉新增（afterMessageId = 打开时的水位 h1）
      final refresh =
          fake.requests.lastWhere((e) => e.key == 'session/messages');
      expect(refresh.value!['afterMessageId'], 'h1');
      expect(store.messages, hasLength(3)); // 历史 + 本回合 user + assistant
      final last = store.messages.last;
      expect(last.text, '写完了');
      final tc = last.processParts
          .firstWhere((p) => p.kind == ChatProcessPartKind.tool)
          .toolCall!;
      expect(tc.toolName, 'FileWrite');
      expect(tc.outputSummary, '写入 3 行');
      expect(store.isStreaming, isFalse);
      // 流式占位被权威版本原位消解（不重复出现"正在写"）
      expect(store.messages.where((m) => m.text == '正在写'), isEmpty);
    });

    test('水位安全（回归）：流式占位不得推进水位——回合中权威合并后仍能拉回最终版本', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      // 预置历史形成水位 h1
      server.session('sess-w').messages.add(
            fakeMsg(
              'user',
              [
                {'type': 'text', 'text': '旧问题'},
              ],
              id: 'h1',
              created: 1,
            ),
          );
      final store = pairedStore(fake);
      await store.openSession('sess-w');
      expect(store.messages, hasLength(1));

      await store.sendMessage('写文件');
      // 流式占位采纳 assistantMessageId msg-a1——服务端权威列表此刻还没有它
      pushEvent(
        store,
        sessionId: 'sess-w',
        type: 'model.streaming',
        seq: 1,
        turnId: 'turn-w',
        payload: {
          'assistantMessageId': 'msg-a1',
          'delta': '正在写',
          'kind': 'text_delta',
        },
      );

      // 回合在途时发生一次权威合并（真实场景：切走再切回，openSession
      // 重拉尾窗）。服务端此刻只有 h1 + user（assistant 尚未落库）。
      await store.openSession('sess-w');
      final reopenFetch =
          fake.requests.lastWhere((e) => e.key == 'session/messages');
      expect(reopenFetch.value!['afterMessageId'], 'h1');

      // 服务端此刻落库 assistant（msg-a1 带工具结果）。若占位曾推进水位
      //（afterMessageId 已被抬到 msg-a1），此消息的最终版本将永远拉不回。
      server.session('sess-w').messages.add(
            fakeMsg(
              'assistant',
              [
                {'type': 'text', 'text': '写完了'},
                {
                  'type': 'tool',
                  'callID': 'tc-w',
                  'tool': 'FileWrite',
                  'state': {'status': 'completed', 'output': 'ok'},
                },
              ],
              id: 'msg-a1',
              created: 2,
            ),
          );
      // turn.completed(带工具) → 增量权威刷新
      pushEvent(
        store,
        sessionId: 'sess-w',
        type: 'turn.completed',
        seq: 2,
        turnId: 'turn-w',
        payload: {
          'response': '写完了',
          'toolCallCount': 1,
          'resultType': 'success',
        },
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 关键断言：刷新水位 = 上一批**权威数据**的尾部（send 落库的 user
      // 消息 srv-u-1），而不是未确认的流式占位 msg-a1
      final refresh =
          fake.requests.lastWhere((e) => e.key == 'session/messages');
      expect(refresh.value!['afterMessageId'], 'srv-u-1');
      // msg-a1 的最终版本（含工具卡片）被完整拉回并原位消解占位
      expect(store.messages, hasLength(3));
      final last = store.messages.last;
      expect(last.text, '写完了');
      final tc = last.processParts
          .firstWhere((p) => p.kind == ChatProcessPartKind.tool)
          .toolCall!;
      expect(tc.toolCallId, 'tc-w');
      expect(store.isStreaming, isFalse);
    });

    test('lastProtoId 只认已确认（synced）条目——缓存水位推导不被占位污染', () {
      final state = ZcodeSessionState('sess-z');
      state.mergeAuthoritative(
        [
          ZcodeSessionItem(
            message: ChatMessage(
              role: MessageRole.user,
              processParts: const [ChatProcessPart.text('q')],
              createdAt: DateTime.fromMillisecondsSinceEpoch(1),
            ),
            protoId: 'm1',
            synced: true,
          ),
        ],
      );
      expect(state.lastProtoId, 'm1');
      // 流式占位采纳了更新的 protoId，但仍未确认：不得成为水位推导对象
      state.ensureStreamingPlaceholder();
      state.adoptStreamingProtoId('msg-a1');
      state.appendTextDelta('partial');
      expect(state.lastProtoId, 'm1');
      // 占位被权威版本消解（synced 置真）后才可推进
      state.mergeAuthoritative(
        [
          ZcodeSessionItem(
            message: ChatMessage(
              role: MessageRole.assistant,
              processParts: const [ChatProcessPart.text('partial+full')],
              createdAt: DateTime.fromMillisecondsSinceEpoch(2),
            ),
            protoId: 'msg-a1',
            synced: true,
          ),
        ],
      );
      expect(state.lastProtoId, 'msg-a1');
    });

    test('乱串杜绝：会话 A 流式中途切到 B——A 增量零泄漏进 B，切回 A 完整', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('sess-A');
      await store.sendMessage('A 任务');
      pushEvent(
        store,
        sessionId: 'sess-A',
        type: 'model.streaming',
        seq: 1,
        turnId: 't-A',
        payload: {
          'assistantMessageId': 'msg-a',
          'delta': '部分A',
          'kind': 'text_delta',
        },
      );
      expect(store.messages.last.text, '部分A');

      // A 流式中途切到 B
      await store.openSession('sess-B');
      expect(store.activeSessionId, 'sess-B');
      // A 的增量继续到达（后台）：不得进入 B 视口
      pushEvent(
        store,
        sessionId: 'sess-A',
        type: 'model.streaming',
        seq: 2,
        turnId: 't-A',
        payload: {
          'assistantMessageId': 'msg-a',
          'delta': '更多A',
          'kind': 'text_delta',
        },
      );
      pushEvent(
        store,
        sessionId: 'sess-B',
        type: 'model.streaming',
        seq: 1,
        turnId: 't-B',
        payload: {
          'assistantMessageId': 'msg-b',
          'delta': 'B 内容',
          'kind': 'text_delta',
        },
      );
      final bContents = store.messages.map((m) => m.text).toList();
      expect(bContents, isNot(contains('部分A')));
      expect(bContents, isNot(contains('更多A')));
      expect(bContents.last, 'B 内容');
      expect(store.liveThinkingText, isEmpty); // A 的回合状态不泄漏

      // 切回 A：内容完整（含后台到达的增量），回合仍在途
      await store.openSession('sess-A');
      expect(store.messages.last.text, '部分A更多A');
      expect(store.isStreaming, isTrue);
      // B 的后续增量不泄漏进 A
      pushEvent(
        store,
        sessionId: 'sess-B',
        type: 'model.streaming',
        seq: 2,
        turnId: 't-B',
        payload: {
          'assistantMessageId': 'msg-b',
          'delta': '后续B',
          'kind': 'text_delta',
        },
      );
      expect(
        store.messages.map((m) => m.text),
        isNot(contains('后续B')),
      );
    });

    test('epoch 失效：在途 resume 失败不惊动当前视口', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final originalResume = fake.handlers['session/resume'];
      // sess-A 的 resume 挂起，稍后以失败收场
      final gate = Completer<void>();
      fake.handlers['session/resume'] = (params) async {
        if (params?['sessionId'] == 'sess-A') {
          await gate.future;
          throw const ZcodeRequestException(-32004, 'Session is not active');
        }
        return originalResume!(params);
      };
      final store = pairedStore(fake);

      final openingA = store.openSession('sess-A'); // 不等待：A 的 resume 在途
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      // A 在途期间切到 B（正常打开）
      await store.openSession('sess-B');
      expect(store.activeSessionId, 'sess-B');

      gate.complete(); // A 的 resume 现在失败
      await openingA;
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      // 旧纪元的失败被丢弃：不踢出视口、不弹错误
      expect(store.activeSessionId, 'sess-B');
      expect(store.error, isNull);
      expect(store.messages, isEmpty);
    });

    test('断线补放：重连后重订阅 + 按 lastSeq 补齐去重', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('sess-r');
      await store.sendMessage('hi');
      pushEvent(
        store,
        sessionId: 'sess-r',
        type: 'model.streaming',
        seq: 1,
        turnId: 't-r',
        payload: {
          'assistantMessageId': 'msg-r',
          'delta': 'A',
          'kind': 'text_delta',
        },
      );
      pushEvent(
        store,
        sessionId: 'sess-r',
        type: 'model.streaming',
        seq: 2,
        turnId: 't-r',
        payload: {
          'assistantMessageId': 'msg-r',
          'delta': 'B',
          'kind': 'text_delta',
        },
      );
      expect(store.messages.last.text, 'AB');

      // 断线期间 seq 3 发生在服务端；重连时补放混入已应用的 seq 2
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'ev-sess-r-2',
                'seq': 2,
                'sessionId': 'sess-r',
                'payload': {'kind': 'text_delta', 'delta': 'B'},
              },
              {
                'eventId': 'ev-sess-r-3',
                'seq': 3,
                'sessionId': 'sess-r',
                'payload': {'kind': 'text_delta', 'delta': 'C'},
              },
            ],
          };
      store.debugSimulateRelayState(ZcodeRelayState.closed, false);
      store.debugSimulateRelayState(ZcodeRelayState.matched, true);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 重连后重订阅（订阅不因切走/断线移除）
      expect(
        fake.requests.where((e) => e.key == 'session/subscribe').length,
        greaterThanOrEqualTo(2),
      );
      // 补放请求带 lastSeq 水位
      final replay = fake.requests.lastWhere((e) => e.key == 'session/events');
      expect(replay.value!['afterSeq'], 2);
      // 重复的 seq 2 按 eventId 去重，只应用新的 seq 3
      expect(store.messages.last.text, 'ABC');
    });

    test('本地缓存：写入后重建 store 秒开（恢复消息与水位）', () async {
      final cache = FakeZcodeSessionCache();
      final fake1 = FakeZcodeRelayClient();
      final server1 = FakeSessionServer()..bind(fake1);
      server1.session('sess-c').messages.add(
            fakeMsg(
              'user',
              [
                {'type': 'text', 'text': '历史问题'},
              ],
              id: 'h1',
              created: 1,
            ),
          );
      server1.session('sess-c').messages.add(
            fakeMsg(
              'assistant',
              [
                {'type': 'text', 'text': '历史回答'},
              ],
              id: 'h2',
              created: 2,
            ),
          );
      final store1 = ZcodeChatStore(cache: cache)
        ..attach(fake1, desktopId: 'device-sid-1', desktopName: '测试桌面');
      await store1.openSession('sess-c');
      expect(store1.messages, hasLength(2));
      await Future<void>.delayed(Duration.zero); // persistSession 为 unawaited
      await Future<void>.delayed(Duration.zero);
      expect(cache.messages['sess-c'], isNotEmpty);
      expect(cache.cursors['sess-c']?.watermark, 'h2');

      // 重建 store（模拟 App 重启）：缓存先出，水位恢复驱动增量刷新
      final fake2 = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake2); // 服务端视角该会话为空
      final store2 = ZcodeChatStore(cache: cache)
        ..attach(fake2, desktopId: 'device-sid-1', desktopName: '测试桌面');
      await store2.openSession('sess-c');
      expect(store2.messages.map((m) => m.text), contains('历史回答'));
      expect(
        fake2.requests.any(
          (e) =>
              e.key == 'session/messages' && e.value?['afterMessageId'] == 'h2',
        ),
        isTrue,
      );
    });

    test('上滑翻页：从本地缓存加载更早消息', () async {
      final cache = FakeZcodeSessionCache();
      cache.messages['sess-o'] = [
        for (var i = 0; i < 120; i++)
          ZcodeSessionItem(
            protoId: 'h$i',
            message: ChatMessage(
              role: i % 2 == 0 ? MessageRole.user : MessageRole.assistant,
              processParts: [ChatProcessPart.text('历史 $i')],
              createdAt: DateTime.fromMillisecondsSinceEpoch(i),
            ),
          ),
      ];
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = ZcodeChatStore(cache: cache)
        ..attach(fake, desktopId: 'device-sid-1', desktopName: '测试桌面');
      await store.openSession('sess-o');
      expect(store.messages, hasLength(80)); // 缓存尾窗

      final added = await store.loadOlderMessages(limit: 40);
      expect(added, 40);
      expect(store.messages, hasLength(120));
      expect(store.messages.first.text, '历史 0');
      expect(store.messages.last.text, '历史 119');
    });

    test('多会话并发：A 后台回合收尾（通知/徽标刷新），B 视口零扰动', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = pairedStore(fake);
      await store.openSession('sess-A');
      await store.sendMessage('A 任务');
      pushEvent(
        store,
        sessionId: 'sess-A',
        type: 'model.streaming',
        seq: 1,
        turnId: 't-A',
        payload: {
          'assistantMessageId': 'msg-ab',
          'delta': '答案A',
          'kind': 'text_delta',
        },
      );
      await store.openSession('sess-B');

      // A 的回合在后台结束（纯文本 → 本地收尾）
      pushEvent(
        store,
        sessionId: 'sess-A',
        type: 'turn.completed',
        seq: 2,
        turnId: 't-A',
        payload: {
          'response': '答案A',
          'tokenCount': 7,
          'toolCallCount': 0,
          'resultType': 'success',
        },
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(store.activeSessionId, 'sess-B'); // 视口未被打扰
      expect(store.messages, isEmpty);
      // 后台完成通知带 A 的 sessionId
      expect(notifier.shown.single['sessionId'], 'sess-A');
      // 会话列表徽标靠 session/list 刷新
      expect(fake.requests.any((e) => e.key == 'session/list'), isTrue);

      // 切回 A：本地收尾内容完整
      await store.openSession('sess-A');
      expect(store.messages.last.text, '答案A');
      expect(store.messages.last.isStreaming, isFalse);
      expect(store.isStreaming, isFalse);
    });

    test('模型兜底：send 字符串拒绝 → setModel 自动切换后重发成功', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('sess-m');
      // 注入可用模型列表（state.updated 全量快照）
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'sess-m',
            'patch': {
              'model': {
                'available': [
                  {
                    'ref': {
                      'providerId': 'builtin:bigmodel-coding-plan',
                      'modelId': 'glm-5.3',
                    },
                  },
                ],
              },
            },
          },
        ),
      );
      var sendCalls = 0;
      fake.handlers['session/send'] = (_) {
        sendCalls++;
        return sendCalls == 1
            ? '历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。'
            : {'accepted': true};
      };
      fake.handlers['session/setModel'] = (_) => {'ok': true};

      await store.sendMessage('hi');
      expect(fake.requests.any((e) => e.key == 'session/setModel'), isTrue);
      final setModel =
          fake.requests.firstWhere((e) => e.key == 'session/setModel');
      expect(setModel.value, {
        'sessionId': 'sess-m',
        // setModel 实测只接受对象格式（字符串 'p/m' 会被 -32602 拒绝）
        'model': {
          'providerId': 'builtin:bigmodel-coding-plan',
          'modelId': 'glm-5.3',
        },
      });
      expect(sendCalls, 2); // 拒绝后自动重发一次
      // probe-modelheal4 验证时序：setModel → close → resume（重新物化）→ 重发
      final keys = fake.requests.map((e) => e.key).toList();
      final resendIdx = keys.lastIndexOf('session/send');
      expect(
        keys.sublist(resendIdx - 3, resendIdx + 1),
        ['session/setModel', 'session/close', 'session/resume', 'session/send'],
      );
      expect(store.error, isNull);
      expect(store.isStreaming, isTrue); // 重发被接受，回合在途
      expect(store.messages.where((m) => m.text == 'hi'), hasLength(1));
    });

    test('模型兜底：resume 播种可用模型 + 错误帧 -32031 走 setModel 重发', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      // resume 响应带 settings.model.available（实测形状）→ 播种可用模型缓存
      fake.handlers['session/resume'] = (params) => {
            'projection': {'status': 'idle'},
            'messages': <Map<String, dynamic>>[],
            'session': {'sessionId': params!['sessionId']},
            'settings': {
              'model': {
                'available': [
                  {
                    'ref': {
                      'providerId': 'builtin:bigmodel-coding-plan',
                      'modelId': 'glm-5.3',
                    },
                  },
                ],
              },
            },
          };
      final store = pairedStore(fake);
      await store.openSession('sess-e1');
      var sendCalls = 0;
      fake.handlers['session/send'] = (_) {
        sendCalls++;
        if (sendCalls == 1) {
          // 真机实测形态：错误帧 -32031（非字符串 result）
          throw const ZcodeRequestException(
            -32031,
            '历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。',
          );
        }
        return {'accepted': true};
      };
      fake.handlers['session/setModel'] = (_) => {'ok': true};

      await store.sendMessage('hi');
      expect(fake.requests.any((e) => e.key == 'session/setModel'), isTrue);
      final setModel =
          fake.requests.firstWhere((e) => e.key == 'session/setModel');
      expect(setModel.value, {
        'sessionId': 'sess-e1',
        'model': {
          'providerId': 'builtin:bigmodel-coding-plan',
          'modelId': 'glm-5.3',
        },
      });
      expect(sendCalls, 2); // 错误帧被拒后自动重发一次
      expect(store.error, isNull);
      expect(store.isStreaming, isTrue); // 重发被接受，回合在途
    });

    test('模型兜底：setModel 后重发仍 -32031 → 提示新建会话（历史模型污染）', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('sess-e2');
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'sess-e2',
            'patch': {
              'model': {
                'available': [
                  {
                    'ref': {'providerId': 'p', 'modelId': 'm'},
                  },
                ],
              },
            },
          },
        ),
      );
      // 即使按 probe-modelheal4 时序 setModel + close + resume 重新物化，
      // 重发仍可能以错误帧 -32031 被拒（provider 真不可用）→ 提示新建会话
      fake.handlers['session/send'] = (_) => throw const ZcodeRequestException(
            -32031,
            '历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。',
          );
      fake.handlers['session/setModel'] = (_) => {'ok': true};

      await store.sendMessage('hi');
      expect(fake.requests.any((e) => e.key == 'session/setModel'), isTrue);
      // 自愈链完整走过（setModel → close → resume → 重发）
      final keys = fake.requests.map((e) => e.key).toList();
      final resendIdx = keys.lastIndexOf('session/send');
      expect(
        keys.sublist(resendIdx - 3, resendIdx + 1),
        ['session/setModel', 'session/close', 'session/resume', 'session/send'],
      );
      expect(store.error, contains('新建会话'));
      expect(store.isStreaming, isFalse);
      expect(store.messages.last.isStreaming, isFalse); // 占位已终结
    });

    test('模型兜底：无可用模型 → 提示原文拒绝', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('sess-m2');
      fake.handlers['session/send'] = (_) => '历史任务使用的模型已不可用，请重新选择模型';

      await store.sendMessage('hi');
      expect(store.error, contains('模型已不可用'));
      expect(store.isStreaming, isFalse);
      expect(store.messages.last.isStreaming, isFalse); // 占位已终结
      expect(fake.requests.any((e) => e.key == 'session/setModel'), isFalse);
    });

    test('模型兜底：非模型类字符串拒绝不触发 setModel（避免擅改会话配置）', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession('sess-m3');
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'sess-m3',
            'patch': {
              'model': {
                'available': [
                  {
                    'ref': {'providerId': 'p', 'modelId': 'm'},
                  },
                ],
              },
            },
          },
        ),
      );
      fake.handlers['session/send'] = (_) => '配额已耗尽，请稍后再试';
      fake.handlers['session/setModel'] = (_) => {};

      await store.sendMessage('hi');
      expect(fake.requests.any((e) => e.key == 'session/setModel'), isFalse);
      expect(store.error, contains('配额已耗尽'));
      expect(store.isStreaming, isFalse);
    });

    test('权威合并：含多条未匹配 assistant 的工具回合消息不丢失', () async {
      final fake = FakeZcodeRelayClient();
      final server = FakeSessionServer()..bind(fake);
      server.session('sess-mm').messages.add(
            fakeMsg(
              'user',
              [
                {'type': 'text', 'text': '旧问题'},
              ],
              id: 'h1',
              created: 1,
            ),
          );
      final store = pairedStore(fake);
      await store.openSession('sess-mm');
      await store.sendMessage('执行任务');
      pushEvent(
        store,
        sessionId: 'sess-mm',
        type: 'model.streaming',
        seq: 1,
        turnId: 'turn-mm',
        payload: {
          'assistantMessageId': 'msg-am',
          'delta': '开始',
          'kind': 'text_delta',
        },
      );
      // 服务端回合：user + 文本 assistant + 工具 assistant + 结果文本
      // （典型 agent 回合：text → tool → text 多条 assistant 消息）
      server.session('sess-mm').messages.addAll(
        [
          fakeMsg(
            'assistant',
            [
              {'type': 'text', 'text': '我先看看'},
            ],
            id: 'msg-am',
            created: 2,
          ),
          fakeMsg(
            'assistant',
            [
              {
                'type': 'tool',
                'callID': 'tc1',
                'tool': 'FileWrite',
                'state': {'status': 'completed'},
              },
            ],
            id: 'msg-tool',
            created: 3,
          ),
          fakeMsg(
            'assistant',
            [
              {'type': 'text', 'text': '写完了'},
            ],
            id: 'msg-final',
            created: 4,
          ),
        ],
      );
      pushEvent(
        store,
        sessionId: 'sess-mm',
        type: 'turn.completed',
        seq: 2,
        turnId: 'turn-mm',
        payload: {'toolCallCount': 1, 'resultType': 'success'},
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      // 全部回合消息存活（不互相顶替）
      final contents = store.messages.map((m) => m.text).toList();
      expect(contents, contains('我先看看'));
      expect(contents, contains('写完了'));
      expect(store.messages.last.text, '写完了');
      expect(store.messages, hasLength(5)); // 历史 + user + 3 条 assistant
    });

    test('回合收尾幂等：idle 兜底先到，turn.completed 后到只收尾一次', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = pairedStore(fake);
      await store.openSession('sess-dup');
      await store.sendMessage('hi');
      pushEvent(
        store,
        sessionId: 'sess-dup',
        type: 'model.streaming',
        seq: 1,
        turnId: 'turn-dup',
        payload: {
          'assistantMessageId': 'msg-dup',
          'delta': '答案',
          'kind': 'text_delta',
        },
      );
      // state.updated idle 兜底先到（跨通道顺序无保证）
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'sess-dup',
            'patch': {'status': 'idle'},
          },
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(notifier.shown, hasLength(1));

      // turn.completed(turnId) 后到：不重复通知/刷新
      pushEvent(
        store,
        sessionId: 'sess-dup',
        type: 'turn.completed',
        seq: 2,
        turnId: 'turn-dup',
        payload: {
          'response': '答案',
          'toolCallCount': 0,
          'resultType': 'success',
        },
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(notifier.shown, hasLength(1));
      expect(store.isStreaming, isFalse);
    });

    test('推送看门狗：订阅成功但推送静默 → 拉起降级轮询；推送恢复即停', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      fake.handlers['session/events'] = (_) => {
            'events': [
              {
                'eventId': 'ev-wd-1',
                'seq': 1,
                'sessionId': 'sess-wd',
                'payload': {'kind': 'text_delta', 'delta': '轮询增量'},
              },
            ],
          };
      final store = pairedStore(fake);
      store.pushWatchdogDelay = const Duration(milliseconds: 60);
      await store.openSession('sess-wd');
      await store.sendMessage('hi');
      expect(fake.requests.any((e) => e.key == 'session/events'), isFalse);

      // 推送静默超过看门狗阈值 → 自动拉起降级轮询
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(fake.requests.any((e) => e.key == 'session/events'), isTrue);
      expect(store.messages.last.text, '轮询增量');

      // 推送恢复：降级轮询停止（不再产生新的 session/events 请求）
      pushEvent(
        store,
        sessionId: 'sess-wd',
        type: 'model.streaming',
        seq: 2,
        turnId: 't-wd',
        payload: {
          'assistantMessageId': 'msg-wd',
          'delta': '推送增量',
          'kind': 'text_delta',
        },
      );
      final eventsCount =
          fake.requests.where((e) => e.key == 'session/events').length;
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(
        fake.requests.where((e) => e.key == 'session/events').length,
        eventsCount,
      );
      expect(store.messages.last.text, '轮询增量推送增量');
      store.dispose();
    });
  });

  group('权限模式 / 错误横幅 / 本地缓存（UI 换芯补充能力）', () {
    test('setMode：合法枚举发送 session/setMode 并乐观更新 sessionMode', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      fake.handlers['session/setMode'] = (params) => {
            'projection': {'mode': 'build', 'status': 'idle'},
          };
      final store = pairedStore(fake);
      await store.openSession('sess-mode');
      expect(store.sessionMode, isNull);

      expect(await store.setMode('yolo'), isTrue);
      expect(
        fake.requests.last,
        isA<MapEntry<String, Map<String, dynamic>?>>()
            .having((e) => e.key, 'method', 'session/setMode')
            .having(
          (e) => e.value,
          'params',
          {'sessionId': 'sess-mode', 'mode': 'yolo'},
        ),
      );
      // 乐观更新（不采纳响应快照的 build 口径）
      expect(store.sessionMode, 'yolo');
    });

    test('setMode：非法枚举 / 未打开会话 → false + error', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);

      expect(await store.setMode('bypass'), isFalse);
      expect(store.error, contains('未知权限模式'));
      store.clearError();
      expect(store.error, isNull);

      expect(await store.setMode('plan'), isFalse);
      expect(store.error, isNotNull);
    });

    test('mode 权威回填：state.updated 的 patch.mode.current 覆盖本地值', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      fake.handlers['session/setMode'] = (_) => {};
      final store = pairedStore(fake);
      await store.openSession('sess-mode2');
      await store.setMode('edit');

      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'state.updated',
          params: {
            'sessionId': 'sess-mode2',
            'patch': {
              'mode': {'current': 'auto'},
            },
          },
        ),
      );
      expect(store.sessionMode, 'auto');
    });

    test('sessionOpening：打开中（未 materialize 且无缓存）为真，完成后为假', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      expect(store.sessionOpening, isFalse); // 无活动会话

      final opening = store.openSession('sess-open');
      // resume 尚未完成：视口容器已建立且无内容 → 骨架屏
      expect(store.sessionOpening, isTrue);
      await opening;
      expect(store.sessionOpening, isFalse);
    });

    test('clearLocalCache：委托缓存清空', () async {
      final cache = FakeZcodeSessionCache();
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final store = ZcodeChatStore(cache: cache)
        ..attach(fake, desktopId: 'device-sid-1', desktopName: '测试桌面');

      await store.clearLocalCache();
      expect(cache.clearAllCalls, 1);
    });
  });

  group('回合指标（首字延迟 / tok/s）', () {
    // 墙钟驱动（store 内部容器不注入时钟），只断言结构性语义：
    // 逐帧可用性/收尾滚存，不断言具体毫秒值
    test('流式期 getter 逐帧可用；turn.completed 后滚存权威值', () async {
      final fake = FakeZcodeRelayClient();
      FakeSessionServer().bind(fake);
      final notifier = FakeZcodeNotifier();
      ZcodeNotifier.setInstanceForTest(notifier);
      final store = pairedStore(fake);
      await store.openSession('sess-m');

      await store.sendMessage('hi');
      expect(store.firstTokenLatencyMs, isNull); // 首增量未到
      expect(store.estimatedTokensPerSecond, isNull);
      expect(store.streamElapsed, isNotNull); // 已起表

      var seq = 0;
      void push(String type, Map<String, dynamic> payload) {
        seq++;
        pushEvent(
          store,
          sessionId: 'sess-m',
          type: type,
          seq: seq,
          turnId: 'turn-1',
          payload: payload,
        );
      }

      push('model.streaming', {
        'assistantMessageId': 'msg-a1',
        'delta': 'Hel',
        'kind': 'text_delta',
      });
      expect(store.firstTokenLatencyMs, isNotNull);
      // 同毫秒内读取窗口跨度为 0 → null 是合法值，推进真实时钟再断言
      await Future<void>.delayed(const Duration(milliseconds: 25));
      expect(store.estimatedTokensPerSecond, isNotNull);

      push('model.streaming', {
        'assistantMessageId': 'msg-a1',
        'delta': 'lo',
        'kind': 'text_delta',
      });
      push('turn.completed', {
        'response': 'Hello',
        'tokenCount': 42,
        'toolCallCount': 0,
        'resultType': 'success',
        'usage': {'inputTokens': 40, 'outputTokens': 20},
      });
      expect(store.isStreaming, isFalse);
      expect(store.lastFirstTokenMs, isNotNull);
      expect(store.lastTurnTokensPerSecond, isNotNull);
      expect(store.streamElapsed, isNull); // 回合已收尾，无在途计时
    });
  });

  group('实时过程流（canonical lifecycle）', () {
    Future<ZcodeChatStore> liveStore(
      FakeZcodeRelayClient fake,
      String sessionId,
    ) async {
      FakeSessionServer().bind(fake);
      final store = pairedStore(fake);
      await store.openSession(sessionId);
      await store.sendMessage('hi');
      return store;
    }

    test('tool_input 组装输入 + tool.updated 原位推进到 result，不另起新行', () async {
      final fake = FakeZcodeRelayClient();
      final store = await liveStore(fake, 'sess-live');
      var seq = 0;
      void push(String type, Map<String, dynamic> payload) {
        seq++;
        pushEvent(
          store,
          sessionId: 'sess-live',
          type: type,
          seq: seq,
          turnId: 'turn-1',
          payload: payload,
        );
      }

      push('model.streaming', {
        'assistantMessageId': 'msg-a',
        'delta': '想一想',
        'kind': 'reasoning_delta',
      });
      push('model.streaming', {
        'assistantMessageId': 'msg-a',
        'delta': '',
        'kind': 'tool_input_start',
        'toolCallId': 'call_1',
        'toolName': 'Bash',
      });
      push('model.streaming', {
        'assistantMessageId': 'msg-a',
        'delta': '{"command":"ls"}',
        'kind': 'tool_input_delta',
        'toolCallId': 'call_1',
      });
      push('model.streaming', {
        'assistantMessageId': 'msg-a',
        'delta': '',
        'kind': 'tool_input_end',
        'toolCallId': 'call_1',
      });
      push('tool.updated', {
        'kind': 'scheduled',
        'toolCallId': 'call_1',
        'toolName': 'Bash',
        'assistantMessageId': 'msg-a',
        'parallelGroupIndex': 0,
        'canRunParallel': false,
        'inputOmitted': true,
      });
      push('tool.updated', {
        'kind': 'started',
        'toolCallId': 'call_1',
        'startedAt': 1700000000000,
      });
      push('tool.updated', {
        'kind': 'result',
        'toolCallId': 'call_1',
        'result': {'success': true, 'content': '文件列表'},
        'duration': 800,
      });
      push('tool.updated', {
        'kind': 'batch',
        'toolCallIds': ['call_1'],
        'successCount': 1,
        'errorCount': 0,
      });
      await Future<void>.delayed(Duration.zero);

      final last = store.messages.last;
      expect(last.isStreaming, isTrue); // 回合仍在途
      // 原序：reasoning → tool；result 晚到不改变位置、不重复成行
      expect(last.processParts.map((p) => p.kind), [
        ChatProcessPartKind.reasoning,
        ChatProcessPartKind.tool,
      ]);
      final tool = last.processParts[1].toolCall!;
      expect(tool.toolName, 'Bash');
      expect(tool.inputFull, '{"command":"ls"}'); // tool_input_delta 组装
      expect(tool.outputFull, '文件列表'); // result.content
      expect(tool.status, ToolCallStatus.done);
      expect(tool.lifecycle, 'batch');
      expect(tool.elapsedMs, 800);
      store.dispose();
    });

    test('权限拒绝：permission.resolved deny → 工具行 error 并展示原因', () async {
      final fake = FakeZcodeRelayClient();
      final store = await liveStore(fake, 'sess-deny');
      var seq = 0;
      void push(String type, Map<String, dynamic> payload) {
        seq++;
        pushEvent(
          store,
          sessionId: 'sess-deny',
          type: type,
          seq: seq,
          turnId: 'turn-1',
          payload: payload,
        );
      }

      push('tool.updated', {
        'kind': 'scheduled',
        'toolCallId': 'call_x',
        'toolName': 'Agent',
        'assistantMessageId': 'msg-a',
      });
      push('permission.resolved', {
        'toolCallId': 'call_x',
        'toolName': 'Agent',
        'decision': 'deny',
        'reason': 'Auto mode is reserved but not implemented yet',
      });

      final last = store.messages.last;
      final tool = last.processParts
          .firstWhere((p) => p.kind == ChatProcessPartKind.tool)
          .toolCall!;
      expect(tool.status, ToolCallStatus.error);
      expect(tool.isError, isTrue);
      expect(tool.lifecycle, 'permission_denied');
      expect(
        tool.outputSummary,
        'Auto mode is reserved but not implemented yet',
      );
      store.dispose();
    });

    test('streamRecovery.updated：触发权威刷新但绝不绝结在途回合', () async {
      final fake = FakeZcodeRelayClient();
      final store = await liveStore(fake, 'sess-rec');
      var seq = 0;
      void push(String type, Map<String, dynamic> payload) {
        seq++;
        pushEvent(
          store,
          sessionId: 'sess-rec',
          type: type,
          seq: seq,
          turnId: 'turn-1',
          payload: payload,
        );
      }

      push('model.streaming', {
        'assistantMessageId': 'msg-a',
        'delta': '',
        'kind': 'tool_input_start',
        'toolCallId': 'call_1',
        'toolName': 'Read',
      });
      int msgReqs() =>
          fake.requests.where((e) => e.key == 'session/messages').length;
      final before = msgReqs();
      push('streamRecovery.updated', {
        'kind': 'tool_result',
        'assistantMessageId': 'msg-a',
        'toolCallId': 'call_1',
        'toolName': 'Read',
        'resultPartId': 'part_1',
        'committedToolCallIds': ['call_1'],
        'committedAt': '2026-09-18T00:00:00.000Z',
      });
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      // 已提交 → 立即拉一次权威 parts
      expect(msgReqs(), greaterThan(before));
      // 非终端刷新：回合保持在途
      expect(store.isStreaming, isTrue);
      store.dispose();
    });

    test('eventId 去重：telemetry 与 session/event 同 id 不重复成行', () async {
      final fake = FakeZcodeRelayClient();
      final store = await liveStore(fake, 'sess-dedup');
      pushEvent(
        store,
        sessionId: 'sess-dedup',
        type: 'tool.updated',
        seq: 1,
        turnId: 'turn-1',
        payload: {
          'kind': 'scheduled',
          'toolCallId': 'call_1',
          'toolName': 'Bash',
          'assistantMessageId': 'msg-a',
        },
      );
      // telemetry 复用同一 eventId（实测两通道共用）
      store.debugHandleNotify(
        const ZcodeFrame(
          method: 'v4/telemetry/event',
          params: {
            'sessionId': 'sess-dedup',
            'eventId': 'ev-sess-dedup-1',
            'kind': 'tool.lifecycle',
            'phase': 'scheduled',
            'toolCallId': 'call_1',
            'toolName': 'Bash',
          },
        ),
      );

      final last = store.messages.last;
      final toolParts = last.processParts
          .where((p) => p.kind == ChatProcessPartKind.tool)
          .toList();
      expect(toolParts, hasLength(1)); // 去重：不写第二行
      store.dispose();
    });
  });
}
