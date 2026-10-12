// 模型显示名美化契约（对齐官方「GLM-5.3-Flash / DeepSeek-V4-Pro」短名形态）。
// 引擎对第三方模型常把 label 填成小写 modelId——回退路径必须品牌化。
import 'package:flutter_test/flutter_test.dart';
import 'package:wzxclaw_android/services/node_catalog_service.dart';

void main() {
  test('已知家族词品牌化：glm/gpt/deepseek + 尺寸段', () {
    expect(NodeModelEntry.prettifyModelId('glm-5.3-flash'), 'GLM-5.3-Flash');
    expect(NodeModelEntry.prettifyModelId('glm-5.3-flashx'), 'GLM-5.3-FlashX');
    expect(NodeModelEntry.prettifyModelId('gpt-5.6-sol'), 'GPT-5.6-Sol');
    expect(NodeModelEntry.prettifyModelId('gpt-5.4-mini'), 'GPT-5.4-Mini');
    expect(NodeModelEntry.prettifyModelId('deepseek-v4-pro'), 'DeepSeek-V4-Pro');
    expect(NodeModelEntry.prettifyModelId('deepseek-chat'), 'DeepSeek-Chat');
    expect(NodeModelEntry.prettifyModelId('deepseek-reasoner'), 'DeepSeek-Reasoner');
  });

  test('未知词首字母大写兜底，不丢字符；版本段 v4 保持小写 v', () {
    expect(NodeModelEntry.prettifyModelId('kimi-k2'), 'Kimi-K2');
    expect(NodeModelEntry.prettifyModelId('qwen3-max'), 'Qwen3-Max');
    expect(NodeModelEntry.prettifyModelId('opus[1m]'), 'Opus[1m]');
  });

  test('displayLabel：引擎友好名优先；label 与 id 同文时才美化', () {
    const friendly = NodeModelEntry(
      providerId: 'p',
      modelId: 'glm-5.3-flash',
      available: true,
      source: 'engine',
      label: 'GLM-5.3-Flash（旗舰）',
    );
    expect(
      friendly.displayLabel,
      'GLM-5.3-Flash（旗舰）',
      reason: '引擎给了不同友好名：原样保留',
    );

    const rawId = NodeModelEntry(
      providerId: 'imported:deepseek',
      modelId: 'deepseek-v4-pro',
      available: true,
      source: 'engine',
      label: 'deepseek-v4-pro', // 引擎把 label 填成 id 同文
    );
    expect(rawId.displayLabel, 'DeepSeek-V4-Pro');

    const noLabel = NodeModelEntry(
      providerId: 'imported:codex',
      modelId: 'gpt-6-astra',
      available: true,
      source: 'engine',
    );
    expect(noLabel.displayLabel, 'GPT-6-Astra');
  });
}
