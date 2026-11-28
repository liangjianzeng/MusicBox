import 'package:flutter/material.dart';

import '../creation/tier_config.dart';

abstract final class CreationPalette {
  static const background = Color(0xFF090A0F);
  static const surface = Color(0xFF11121A);
  static const raised = Color(0xFF171822);
  static const field = Color(0xFF1D1E2A);
  static const violet = Color(0xFFA78BFA);
  static const violetBright = Color(0xFFC4B5FD);
  static const cyan = Color(0xFF67E8F9);
  static const amber = Color(0xFFFFC857);
  static const green = Color(0xFF4ADE80);
  static const blue = Color(0xFF38BDF8);
  static const text = Color(0xFFF5F3FF);
  static const muted = Color(0xFFA7A5B8);
  static const faint = Color(0xFF6F6D80);
  static const border = Color(0x14FFFFFF);
  static const gradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [violet, Color(0xFF7C6EF6)],
  );
}

class CreationBackdrop extends StatelessWidget {
  const CreationBackdrop({super.key, this.ambient = true});

  final bool ambient;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: SizedBox.expand(
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: CreationPalette.background,
            gradient: ambient
                ? const RadialGradient(
                    center: Alignment(0.92, -0.7),
                    radius: 1.15,
                    colors: [Color(0x332D2358), CreationPalette.background],
                  )
                : null,
          ),
          child: ambient
              ? const DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: RadialGradient(
                      center: Alignment(-0.85, 0.35),
                      radius: 0.9,
                      colors: [Color(0x10326A73), Colors.transparent],
                    ),
                  ),
                )
              : null,
        ),
      ),
    );
  }
}

class CreationTierTabs extends StatelessWidget {
  const CreationTierTabs({
    super.key,
    required this.specs,
    required this.selected,
    required this.onChanged,
  });

  /// 数据驱动的可见档位（`CreationTiers.visible(...)`）。档位名/图标/色板全部来自
  /// spec，不再允许硬编平行数组 —— 第 4/5 个档位（复刻/智能体）由同一数据源给出，
  /// 加档位只改 tier_config，不改本组件（契约 v5.5.15 / v5.7.2）。
  final List<CreationTierSpec> specs;

  /// [specs] 内的下标（不是持久化 tier —— tier 与显示顺序解耦，v5.5.15）。
  final int selected;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    if (specs.isEmpty) return const SizedBox(height: 44);
    return LayoutBuilder(builder: (context, constraints) {
      final width = constraints.maxWidth / specs.length;
      return RepaintBoundary(
        child: SizedBox(
          height: 44,
          child: Stack(
            children: [
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: Container(
                  height: 1,
                  color: CreationPalette.border,
                ),
              ),
              AnimatedPositioned(
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOutCubic,
                left: width * selected,
                bottom: 0,
                width: width,
                child: Container(
                  height: 2,
                  decoration: BoxDecoration(
                    color: CreationPalette.cyan,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              Row(
                children: List.generate(specs.length, (index) {
                  final active = index == selected;
                  final color = specs[index].color;
                  return Expanded(
                    child: Semantics(
                      button: true,
                      selected: active,
                      label: specs[index].label,
                      child: Material(
                        type: MaterialType.transparency,
                        child: InkWell(
                          borderRadius: BorderRadius.circular(12),
                          onTap: () => onChanged(index),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Container(
                                width: 22,
                                height: 22,
                                decoration: BoxDecoration(
                                  color: color.withValues(alpha: .14),
                                  border: Border.all(
                                    color: color.withValues(alpha: .28),
                                  ),
                                  borderRadius: BorderRadius.circular(7),
                                ),
                                child: Icon(
                                  specs[index].icon,
                                  size: 15,
                                  color: color,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  specs[index].label,
                                  style: TextStyle(
                                    color: active
                                        ? CreationPalette.text
                                        : CreationPalette.faint,
                                    fontSize: 14,
                                    height: 1,
                                    fontWeight: active
                                        ? FontWeight.w800
                                        : FontWeight.w600,
                                    letterSpacing: active ? .2 : 0,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                }),
              ),
            ],
          ),
        ),
      );
    });
  }
}

class CreationDock extends StatelessWidget {
  const CreationDock({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: Container(
        decoration: BoxDecoration(
          color: CreationPalette.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(26)),
          border: const Border(top: BorderSide(color: CreationPalette.border)),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: .45),
              blurRadius: 26,
              offset: const Offset(0, -10),
            ),
          ],
        ),
        child: SafeArea(
          top: false,
          minimum: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
            child: child,
          ),
        ),
      ),
    );
  }
}

class CreationInputActions extends StatelessWidget {
  const CreationInputActions({
    super.key,
    required this.voice,
    required this.onPhoto,
    this.compact = false,
  });

  final Widget voice;
  final VoidCallback? onPhoto;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Container(
            constraints: BoxConstraints(minHeight: compact ? 96 : 116),
            padding: EdgeInsets.symmetric(
              horizontal: compact ? 8 : 12,
              vertical: compact ? 8 : 10,
            ),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  CreationPalette.violet.withValues(alpha: .17),
                  CreationPalette.cyan.withValues(alpha: .05),
                ],
              ),
              borderRadius: BorderRadius.circular(20),
              border: Border.all(
                color: CreationPalette.violet.withValues(alpha: .28),
              ),
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                voice,
                if (!compact) ...[
                  const SizedBox(height: 7),
                  const Text(
                    '按住说话',
                    style: TextStyle(
                      color: CreationPalette.text,
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Material(
            color: CreationPalette.raised,
            borderRadius: BorderRadius.circular(20),
            child: InkWell(
              borderRadius: BorderRadius.circular(20),
              onTap: onPhoto,
              child: Container(
                constraints: BoxConstraints(minHeight: compact ? 96 : 116),
                padding: EdgeInsets.symmetric(
                  horizontal: compact ? 8 : 12,
                  vertical: compact ? 8 : 10,
                ),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: CreationPalette.border),
                ),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Container(
                      width: compact ? 52 : 56,
                      height: compact ? 52 : 56,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: Colors.white.withValues(alpha: .045),
                        border: Border.all(color: CreationPalette.border),
                      ),
                      child: const Icon(
                        Icons.photo_camera_rounded,
                        color: CreationPalette.cyan,
                        size: 24,
                      ),
                    ),
                    if (!compact) ...[
                      const SizedBox(height: 8),
                      const Text(
                        '拍照',
                        style: TextStyle(
                          color: CreationPalette.text,
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class CreationSectionLabel extends StatelessWidget {
  const CreationSectionLabel(this.title, {super.key, this.trailing});

  final String title;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          Container(
            width: 3,
            height: 14,
            decoration: BoxDecoration(
              color: CreationPalette.violet,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            title,
            style: const TextStyle(
              color: CreationPalette.text,
              fontSize: 14,
              fontWeight: FontWeight.w800,
              letterSpacing: .1,
            ),
          ),
          if (trailing != null) ...[
            const Spacer(),
            Text(
              trailing!,
              style: const TextStyle(
                color: CreationPalette.faint,
                fontSize: 11,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

OutlineInputBorder creationFieldBorder(Color color, {double width = 1}) {
  return OutlineInputBorder(
    borderRadius: BorderRadius.circular(16),
    borderSide: BorderSide(color: color, width: width),
  );
}

InputDecoration creationFieldDecoration({
  String? hint,
  String? helper,
  bool dense = false,
  bool alignLabelWithHint = false,
}) {
  return InputDecoration(
    hintText: hint,
    helperText: helper,
    helperMaxLines: 2,
    alignLabelWithHint: alignLabelWithHint,
    isDense: dense,
    filled: true,
    fillColor: CreationPalette.field,
    hintStyle: const TextStyle(color: CreationPalette.faint, height: 1.45),
    helperStyle: const TextStyle(color: CreationPalette.faint, fontSize: 11),
    contentPadding: EdgeInsets.symmetric(
      horizontal: 14,
      vertical: dense ? 12 : 15,
    ),
    border: creationFieldBorder(CreationPalette.border),
    enabledBorder: creationFieldBorder(CreationPalette.border),
    focusedBorder: creationFieldBorder(CreationPalette.violet, width: 1.4),
  );
}
