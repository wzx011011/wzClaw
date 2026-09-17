import 'package:flutter/material.dart';

/// 左滑操作定义
class SwipeAction {
  const SwipeAction({
    required this.label,
    required this.icon,
    required this.color,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final Color color;
  final VoidCallback onTap;
}

/// 飞书式左滑操作瓦片：向左拖动露出右侧操作按钮，松手吸附开/合。
/// 垂直滚动不受影响（仅注册水平拖动手势）；打开时点按内容区先收起。
class SwipeActionsTile extends StatefulWidget {
  const SwipeActionsTile({
    super.key,
    required this.actions,
    required this.child,
    this.onOpenedChanged,
  });

  /// 依次从左到右排列（最靠右的离内容最近，符合飞书习惯）
  final List<SwipeAction> actions;
  final Widget child;

  /// 开合状态回调（供父级做「同时只开一个」等互斥）
  final ValueChanged<bool>? onOpenedChanged;

  @override
  State<SwipeActionsTile> createState() => _SwipeActionsTileState();
}

class _SwipeActionsTileState extends State<SwipeActionsTile> {
  static const _actionWidth = 72.0;

  double _dx = 0; // ≤ 0；0 = 合上
  bool _dragging = false;

  double get _maxSwipe => widget.actions.length * _actionWidth;

  bool get _isOpen => _dx <= -_maxSwipe + 1;

  void _setDx(double v) => setState(() => _dx = v.clamp(-_maxSwipe, 0.0));

  void _snapTo(double target) {
    if (_dx == target) return;
    setState(() {
      _dragging = false;
      _dx = target;
    });
    widget.onOpenedChanged?.call(target < 0);
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return Stack(
      children: [
        // 背景：右侧操作按钮
        Positioned.fill(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              for (final action in widget.actions)
                GestureDetector(
                  onTap: () {
                    _snapTo(0);
                    action.onTap();
                  },
                  child: Container(
                    width: _actionWidth,
                    color: action.color,
                    alignment: Alignment.center,
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(action.icon, size: 20, color: Colors.white),
                        const SizedBox(height: 4),
                        Text(action.label,
                            style: const TextStyle(
                                color: Colors.white, fontSize: 12,),),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
        // 前景内容：水平拖动平移。必须自带不透明底色——瓦片本身透明，
        // 否则合上时背后按钮直接透出（2026-09-17 真机事故）
        AnimatedContainer(
          duration: _dragging ? Duration.zero : const Duration(milliseconds: 150),
          curve: Curves.easeOutCubic,
          transform: Matrix4.translationValues(_dx, 0, 0),
          color: colors.bgPrimary,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onHorizontalDragStart: (_) => _dragging = true,
            onHorizontalDragUpdate: (d) => _setDx(_dx + d.delta.dx),
            onHorizontalDragEnd: (_) =>
                _snapTo(_dx <= -_maxSwipe / 2 ? -_maxSwipe : 0),
            onTap: _isOpen
                ? () => _snapTo(0) // 打开态先收起，不触发内容点按
                : null,
            child: IgnorePointer(
              ignoring: _isOpen,
              child: widget.child,
            ),
          ),
        ),
      ],
    );
  }
}
