// relay 建连工厂门面：native 走「IPv6 优先 + IPv4 回退」双栈实现，web 走桩。
// 分层模式与 platform_io.dart 一致（条件导出，web 构建只编译桩）。
export 'relay_connect_factory_real.dart'
    if (dart.library.html) 'relay_connect_factory_stub.dart';
