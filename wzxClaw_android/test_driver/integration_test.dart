// flutter drive 的驱动入口（test/e2e/run-e2e.mjs 经
// `flutter drive --driver=test_driver/integration_test.dart` 使用）。
// 职责只有一件事：在宿主侧等待被测应用（web）里的 integration_test 跑完，
// 把结果回传给 flutter drive 进程——失败即非零退出码。
import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver();
