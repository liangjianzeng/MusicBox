import 'package:flutter/material.dart';

import '../../features/create/creation_ui.dart';

class TagChip extends StatelessWidget {
  const TagChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    this.enabled = true,
  });

  final Widget label;
  final bool selected;
  final VoidCallback? onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final foreground =
        selected ? CreationPalette.violetBright : CreationPalette.muted;
    return Semantics(
      button: true,
      selected: selected,
      enabled: enabled,
      child: Opacity(
        opacity: enabled ? 1 : .34,
        child: Material(
          color: selected
              ? CreationPalette.violet.withValues(alpha: .14)
              : Colors.white.withValues(alpha: .025),
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: enabled ? onTap : null,
            child: Container(
              constraints: const BoxConstraints(minHeight: 34),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: selected
                      ? CreationPalette.violet.withValues(alpha: .42)
                      : Colors.white.withValues(alpha: .07),
                ),
              ),
              child: DefaultTextStyle(
                style: TextStyle(
                  color: foreground,
                  fontSize: 12.5,
                  height: 1.15,
                  fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                ),
                child: IconTheme(
                  data: IconThemeData(color: foreground, size: 13),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (selected) ...[
                        const Icon(Icons.check_rounded, size: 13),
                        const SizedBox(width: 5),
                      ],
                      Flexible(child: label),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
