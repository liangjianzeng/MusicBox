import 'package:flutter/material.dart';

import 'creation_ui.dart';

/// 主按钮旁边的「出几首」选择器（契约 v5.6.15）。
///
/// 为什么不是常见的"一行标签 + 一排 chips"：简约/标准档在 320×568 + 2 倍字号下布局是
/// **0 余量**（`create_layout_test` 抓到过我新加的一行溢出 114px；更早 MoodChips 折行也把
/// sticky 主按钮顶出屏幕 143px）。主操作看不见 = 用户没法拍板，比少一个控件严重得多。
/// 所以它挤在主按钮**同一行**，新增高度 0。
///
/// 每个选项都写出价格：花费必须在**选择的那一刻**可见，而不是扣完才发现
/// （简约/标准档曾把数量写死 3 首，一键闷声 45⚡，而每日免费才 50）。
class CountPicker extends StatelessWidget {
  const CountPicker({
    super.key,
    required this.count,
    required this.unit,
    required this.onChanged,
    this.max = 3,
  });

  final int count;
  final int unit;
  final int max;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<int>(
      initialValue: count,
      tooltip: '出几首',
      color: CreationPalette.raised,
      onSelected: onChanged,
      itemBuilder: (_) => [
        for (var i = 1; i <= max; i++)
          PopupMenuItem<int>(
            value: i,
            // 选项里也带价格：用户在挑"要几首"的当下就该看见各要多少钱
            child: Text(
              '$i 首 · ${unit * i}⚡',
              style: const TextStyle(
                color: CreationPalette.text,
                fontSize: 13,
              ),
            ),
          ),
      ],
      child: Container(
        height: 40,
        padding: const EdgeInsets.symmetric(horizontal: 10),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: CreationPalette.field,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: CreationPalette.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '$count 首',
              style: const TextStyle(
                color: CreationPalette.text,
                fontSize: 13,
                fontWeight: FontWeight.w800,
              ),
            ),
            const Icon(Icons.expand_more_rounded,
                size: 16, color: CreationPalette.faint),
          ],
        ),
      ),
    );
  }
}
