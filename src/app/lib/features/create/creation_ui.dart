import 'package:flutter/material.dart';

abstract final class CreationPalette {
  static const background = Color(0xFF090A0F);
  static const surface = Color(0xFF11121A);
  static const raised = Color(0xFF171822);
  static const field = Color(0xFF1D1E2A);
  static const violet = Color(0xFFA78BFA);
  static const violetBright = Color(0xFFC4B5FD);
  static const cyan = Color(0xFF67E8F9);
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
    return SizedBox.expand(
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
    );
  }
}

class CreationTierTabs extends StatelessWidget {
  const CreationTierTabs({
    super.key,
    required this.selected,
    required this.onChanged,
  });

  final int selected;
  final ValueChanged<int> onChanged;

  static const labels = ['简约', '标准', '深度'];
  static const icons = [
    Icons.auto_awesome_rounded,
    Icons.tune_rounded,
    Icons.equalizer_rounded,
  ];

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, constraints) {
      final width = constraints.maxWidth / labels.length;
      return SizedBox(
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
                  gradient: CreationPalette.gradient,
                  borderRadius: BorderRadius.circular(2),
                  boxShadow: [
                    BoxShadow(
                      color: CreationPalette.violet.withValues(alpha: .45),
                      blurRadius: 10,
                    ),
                  ],
                ),
              ),
            ),
            Row(
              children: List.generate(labels.length, (index) {
                final active = index == selected;
                return Expanded(
                  child: Semantics(
                    button: true,
                    selected: active,
                    label: labels[index],
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
                              gradient: CreationPalette.gradient,
                              borderRadius: BorderRadius.circular(7),
                            ),
                            child: Icon(
                              icons[index],
                              size: 15,
                              color: active
                                  ? Colors.white
                                  : CreationPalette.violetBright,
                            ),
                          ),
                          const SizedBox(width: 6),
                          Flexible(
                            child: AnimatedDefaultTextStyle(
                              duration: const Duration(milliseconds: 160),
                              style: TextStyle(
                                color: active
                                    ? CreationPalette.text
                                    : CreationPalette.faint,
                                fontSize: 14,
                                height: 1,
                                fontWeight:
                                    active ? FontWeight.w800 : FontWeight.w600,
                                letterSpacing: active ? .2 : 0,
                              ),
                              child: Text(labels[index]),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              }),
            ),
          ],
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
    return Container(
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
                        color: CreationPalette.violetBright,
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
