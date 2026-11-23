import 'package:flutter/material.dart';

/// 作品页常驻 “AI 生成” 角标（合规：AI 内容必须标注）
class AiBadge extends StatelessWidget {
  const AiBadge({super.key, this.small = false});

  final bool small;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: small ? 5 : 8, vertical: small ? 1.5 : 3),
      decoration: BoxDecoration(
        color: scheme.primaryContainer.withValues(alpha: 0.9),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.auto_awesome, size: small ? 9 : 11, color: scheme.onPrimaryContainer),
          const SizedBox(width: 2),
          Text(
            'AI 生成',
            style: TextStyle(
              fontSize: small ? 9 : 11,
              fontWeight: FontWeight.w600,
              color: scheme.onPrimaryContainer,
            ),
          ),
        ],
      ),
    );
  }
}
