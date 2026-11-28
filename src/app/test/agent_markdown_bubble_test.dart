/// 助手气泡的 markdown-lite 用例。
///
/// 为什么单独立一个文件测：真机（小米13 98fc9410，2026-11-28）截图里助手把 markdown 原样念了出来 ——
/// 「**1. 情绪基调**」、句尾还挂着一个孤零零的「**」。模型按 markdown 写、气泡是裸 `Text`，
/// 等于把源码甩给用户。这不是"不够漂亮"，是**同一段话在页面上读不通**。
///
/// 判据刻意的两条：① 成对的 `**…**` 必须变粗体；② 落单的星号必须消失（流式尾巴只出一半是常态，
/// 露半个星号比完全没格式更像 bug）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:musicbox/features/agent/ui/agent_step_tile.dart';

/// 把 InlineSpan 树摊平成 (文本, 是否加粗) 的序列，方便断言"渲染出来的字"而不是字符串。
List<(String, bool)> _flatten(List<InlineSpan> spans) {
  final out = <(String, bool)>[];
  void walk(InlineSpan s, bool bold) {
    if (s is TextSpan) {
      final b = bold || s.style?.fontWeight == FontWeight.w700;
      if ((s.text ?? '').isNotEmpty) out.add((s.text!, b));
      for (final c in s.children ?? const <InlineSpan>[]) {
        walk(c, b);
      }
    }
  }
  for (final s in spans) {
    walk(s, false);
  }
  return out;
}

void main() {
  const base = TextStyle(fontSize: 13.5);

  group('助手气泡 markdown-lite', () {
    test('成对的 ** 变成真加粗，字还是那些字', () {
      final got = _flatten(
        agentMarkdownSpans('就按这三条来：**安静专注 / 纯音乐 / Lo-fi**，很适合当背景。', base: base),
      );
      // 拼回去必须与原文去掉星号后一字不差 —— 不许在渲染层丢字
      expect(got.map((e) => e.$1).join(), '就按这三条来：安静专注 / 纯音乐 / Lo-fi，很适合当背景。');
      expect(
        got.firstWhere((e) => e.$1.contains('安静专注')).$2,
        isTrue,
        reason: '加粗没生效：星号是吞了，但字还是平的',
      );
      expect(
        got.firstWhere((e) => e.$1.startsWith('就按')).$2,
        isFalse,
        reason: '普通文字被误加粗',
      );
    });

    test('落单的星号必须消失（流式尾巴只写出一半）', () {
      final got = _flatten(agentMarkdownSpans('先定三件事：**情绪、人声、曲风', base: base));
      final flat = got.map((e) => e.$1).join();
      expect(flat, isNot(contains('*')), reason: '星号露在脸上：$flat');
      expect(flat, '先定三件事：情绪、人声、曲风');
    });

    test('模型爱写的编号题面 **1. 情绪基调** 也要变粗（真机截图就是这个形状）', () {
      final got = _flatten(agentMarkdownSpans('**1. 情绪基调** 你想偏哪边', base: base));
      expect(got.map((e) => e.$1).join(), '1. 情绪基调 你想偏哪边');
      expect(got.first.$2, isTrue);
    });

    test('纯文本一个字都不该被改动', () {
      const plain = '深夜加班听的歌，先定三件事，点完就能开始做。';
      final got = _flatten(agentMarkdownSpans(plain, base: base));
      expect(got.map((e) => e.$1).join(), plain);
      expect(got.every((e) => !e.$2), isTrue);
    });

    test('一行里两处加粗各自独立', () {
      final got = _flatten(agentMarkdownSpans('曲风 **Lo-fi**，情绪 **安静**，收工', base: base));
      expect(got.where((e) => e.$2).map((e) => e.$1), ['Lo-fi', '安静']);
    });
  });
}
