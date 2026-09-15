// 换芯层协议翻译回归测试：审查整改项的契约锚定
// 1) 权限应答必须回放 option.response 原文（其它形状被服务端静默 deny）
// 2) 工具事件按实测 kind 轨迹（scheduled/started/result）翻译
// 3) 权限/AskUser 反向请求解析（含 options 原文与 requestKey）
// 4) callID 大小写、hasMore 推算、配对链接宽容 scheme
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/models/ws_message.dart';
import 'package:wzxclaw_android/services/zcode_protocol_translate.dart';

void main() {
  group('parsePairingUrlAny', () {
    test('https 与 wss 均可，host/port 正确', () {
      final a = parsePairingUrlAny(
          'https://zcode.5945.top/pair?sid=abc&hash=xxx');
      expect(a!.relayWsUrl, 'wss://zcode.5945.top/ws');
      final b = parsePairingUrlAny(
          'wss://zcode.5945.top/pair?sid=abc&hash=xxx');
      expect(b!.relayWsUrl, 'wss://zcode.5945.top/ws');
      expect(parsePairingUrlAny('wss://host/ws?sid='), isNull);
    });
  });

  group('normalizeQrScanToServerUrl（扫码配对链接归一化）', () {
    test('https 配对链接升级为 wss，sid/hash/name 参数原样保留', () {
      final url = normalizeQrScanToServerUrl(
          'https://zcode.5945.top/pair?sid=abc&hash=xxx&name=MY-PC');
      expect(url, 'wss://zcode.5945.top/pair?sid=abc&hash=xxx&name=MY-PC');
      // 归一化结果必须能被 connect() 直接接受（parsePairingUrlAny 非 null）
      expect(parsePairingUrlAny(url!), isNotNull);
    });

    test('wss 配对链接原样返回；非配对链接返回 null 走旧后处理', () {
      expect(normalizeQrScanToServerUrl('wss://zcode.5945.top/pair?sid=a&hash=b'),
          'wss://zcode.5945.top/pair?sid=a&hash=b');
      // 旧 token 二维码（无 sid+hash）：返回 null，不能被误当配对链接
      expect(normalizeQrScanToServerUrl('https://5945.top/relay/?token=tok123'),
          isNull);
      expect(normalizeQrScanToServerUrl('wss://5945.top/relay/'), isNull);
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
          {'decision': 'allow', 'reason': 'Approved once'});
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
      }, const {});
      final msg = (events.single.data as Map)['messages'].single as Map;
      expect((msg['tool_calls'] as List).single,
          containsPair('toolCallId', 'callID_1'));
    });

    test('hasMore 按返回条数==limit 推算', () {
      final events = responseToWsMessages('session/messages', {
        'messages': List.generate(200, (i) => {
              'info': {'role': 'user', 'time': {'created': i}},
              'parts': [
                {'type': 'text', 'text': 'm$i'},
              ],
            }),
      }, const {});
      expect((events.single.data as Map)['hasMore'], true);
    });
  });
}

List<WsMessage> _payload(Map<String, dynamic> payload) =>
    translateNotification('session/event', {
      'sessionId': 's1',
      'events': [
        {'payload': payload},
      ],
    }, (_, __) {});
