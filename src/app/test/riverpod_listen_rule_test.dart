// riverpod 的一条硬规矩，用最小样例钉死 —— 不要靠记忆，也不要靠"上次能跑"。
//
// 起因（2026-11-27 K90 真机）：根壳整屏红
//   'package:flutter_riverpod/src/consumer.dart': Failed assertion: line 600 pos 7:
//   'debugDoingBuild': ref.listen can only be used within the build method of a ConsumerWidget
// 排查中我**两次**凭记忆判断错方向（先怪 ConsumerWidget.build，再把它搬进 ConsumerState.initState），
// 真凶恰恰是 initState。release 关掉 Dart 断言，所以这类错误在线上**完全隐形**。
// 与其在注释里写"我记得可以用"，不如让这四行断言替我记得。
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

final _p = StateProvider<int>((ref) => 0);

class _FromStateInitState extends ConsumerStatefulWidget {
  const _FromStateInitState();
  @override
  ConsumerState<_FromStateInitState> createState() => _S();
}

class _S extends ConsumerState<_FromStateInitState> {
  @override
  void initState() {
    super.initState();
    ref.listen(_p, (_, __) {}); // ← 真机红屏的写法
  }

  @override
  Widget build(BuildContext context) => const SizedBox.shrink();
}

class _FromConsumerWidgetBuild extends ConsumerWidget {
  const _FromConsumerWidgetBuild();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(_p, (_, __) {}); // ← 合法写法
    return const SizedBox.shrink();
  }
}

class _FromStateBuild extends ConsumerStatefulWidget {
  const _FromStateBuild();
  @override
  ConsumerState<_FromStateBuild> createState() => _S2();
}

class _S2 extends ConsumerState<_FromStateBuild> {
  @override
  Widget build(BuildContext context) {
    ref.listen(_p, (_, __) {}); // ← 合法写法（本次修复采用的位置）
    return const SizedBox.shrink();
  }
}

Future<Object?> _run(WidgetTester tester, Widget page) async {
  await tester.pumpWidget(ProviderScope(child: MaterialApp(home: page)));
  await tester.pump();
  // 框架级构建错误不是普通 throw：它由 FlutterError 记下，要用 takeException 取
  return tester.takeException();
}

void main() {
  testWidgets('ConsumerState.initState 里 ref.listen 会抛断言（所以永远别这么写）',
      (tester) async {
    final err = await _run(tester, const _FromStateInitState());
    expect(err, isA<AssertionError>(),
        reason: 'riverpod 允许在 build 里 listen、不允许在 initState —— 若哪天升级后这条变了，'
            '本用例会红，届时重新确认规则，而不是凭印象改代码');
  });

  testWidgets('ConsumerWidget.build 与 ConsumerState.build 里 ref.listen 都合法',
      (tester) async {
    expect(await _run(tester, const _FromConsumerWidgetBuild()), isNull);
    expect(await _run(tester, const _FromStateBuild()), isNull);
  });
}
