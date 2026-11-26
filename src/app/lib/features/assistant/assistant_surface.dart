import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/api_client.dart';
import '../../core/speech/speech_service.dart';
import '../../core/speech/speech_settings.dart';
import '../../core/state.dart';
import '../../features/player/player_provider.dart';
import '../create/progress_page.dart';
import '../library/work_detail_page.dart';
import 'assistant_api_client.dart';
import 'assistant_models.dart';
import 'assistant_state.dart';
import 'assistant_voice.dart';

Future<void> showGlobalAssistant(BuildContext context,
    {AssistantTab tab = AssistantTab.chat, String? prompt,
    String? surface, List<AssistantRef>? refs}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: false,
    backgroundColor: Colors.transparent,
    builder: (ctx) {
      final media = MediaQuery.of(ctx);
      final heightFactor = tab == AssistantTab.chat ? .56 : .68;
      // 固定高度面板：高度恒定（不随消息数变化 → 不跳动），内容区内部滚动。
      // 高度足够大，键盘弹出时顶部输入行始终在键盘之上。
      final panelH = media.size.height * heightFactor;
      return Align(
        alignment: Alignment.bottomCenter,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: 440,
            minHeight: panelH,
            maxHeight: panelH,
          ),
          child: AssistantPanel(
            initialTab: tab,
            initialPrompt: prompt,
            initialSurface: surface,
            initialRefs: refs,
          ),
        ),
      );
    },
  );
}

Future<void> showAssistantCenter(BuildContext context) =>
    showGlobalAssistant(context, tab: AssistantTab.tasks);

class AssistantDock extends ConsumerWidget {
  const AssistantDock({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(assistantProvider);
    final rc = ref.watch(remoteConfigProvider);
    if ((rc != null && !rc.assistantCore) || !state.available) {
      return const SizedBox.shrink();
    }
    final pending = state.pendingTickets;
    return Tooltip(
      message: '创作助手',
      child: Material(
        color: const Color(0xFF17181F),
        child: InkWell(
          onTap: () => showGlobalAssistant(context),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
            child: Row(
              children: [
                const Icon(Icons.auto_awesome,
                    size: 14, color: Color(0xFFFFC86B)),
                const SizedBox(width: 5),
                const Text('助手',
                    style: TextStyle(fontSize: 11, color: Colors.white70)),
                const Spacer(),
                if (state.activeTasks > 0)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: Text('${state.activeTasks} 项进行中',
                        style: const TextStyle(
                            fontSize: 10, color: Colors.white38)),
                  ),
                if (pending > 0) ...[
                  Badge(
                    label:
                        Text('$pending', style: const TextStyle(fontSize: 9)),
                    child: const Icon(Icons.fact_check_outlined,
                        size: 14, color: Colors.white54),
                  ),
                  const SizedBox(width: 4),
                ],
                const Icon(Icons.chevron_right,
                    size: 14, color: Colors.white24),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class AssistantPanel extends ConsumerStatefulWidget {
  const AssistantPanel(
      {super.key,
      this.initialTab = AssistantTab.chat,
      this.initialPrompt,
      this.initialSurface,
      this.initialRefs});

  final AssistantTab initialTab;
  final String? initialPrompt;
  final String? initialSurface;
  final List<AssistantRef>? initialRefs;

  @override
  ConsumerState<AssistantPanel> createState() => _AssistantPanelState();
}

class _AssistantPanelState extends ConsumerState<AssistantPanel> {
  late AssistantTab _tab = widget.initialTab;
  final _input = TextEditingController();
  final _scrollController = ScrollController();
  int? _lastMessageCount;
  bool _attachContext = true;
  late final AssistantVoiceController _voice;
  String? _pendingImageId;
  bool _imageUploading = false;

  @override
  void initState() {
    super.initState();
    // 薄壳预绑定：从特定对象（作品/灵感卡/项目）打开时注入 surface/refs；未注入则清空，
    // 保证每次打开的上下文干净、可预期（统一 surface 作为唯一助手入口）。
    // 延迟到微任务，避免在 build 阶段修改被 watch 的 provider 触发 Riverpod 报错。
    Future<void>.delayed(Duration.zero, () {
      if (!mounted) return;
      ref.read(assistantContextProvider.notifier).state = AssistantContext(
          surface: widget.initialSurface ?? 'create',
          refs: widget.initialRefs ?? const []);
    });
    _voice = AssistantVoiceController(
      service: ref.read(speechServiceProvider),
      inputController: _input,
      coordination: SpeechCoordination(
        isPlaying: () => ref.read(playerProvider).playing,
        pause: () => ref.read(playerProvider.notifier).audio.pause(),
        resume: () => ref.read(playerProvider.notifier).audio.play(),
      ),
    );
    final prompt = widget.initialPrompt?.trim();
    if (prompt != null && prompt.isNotEmpty) {
      _input.text = prompt;
    }
  }

  @override
  void dispose() {
    _voice.dispose();
    _input.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _submit([String? quick]) async {
    final text = (quick ?? _input.text).trim();
    final imageId = _pendingImageId;
    if (text.isEmpty && imageId == null) return;
    _input.clear();
    _pendingImageId = null;
    // 只传图没打字时，给个默认引导语，保证图片能进入理解链
    final actualText = text.isEmpty ? '请描述这张图' : text;
    await ref
        .read(assistantProvider.notifier)
        .send(actualText, attachContext: _attachContext, imageId: imageId);
    // 自动朗读：只念助手给的话，念的是端侧过滤后的文案（与屏显同源）
    if (ref.read(speechSettingsProvider).autoSpeak) {
      final replies = ref
          .read(assistantProvider)
          .messages
          .where((m) => m.role == 'assistant')
          .toList();
      if (replies.isNotEmpty) {
        _voice.speak(userVisibleText(replies.last.content));
      }
    }
  }

  void _selectTab(AssistantTab tab) {
    setState(() {
      _tab = tab;
      if (tab != AssistantTab.chat) _voice.cancelTalk();
    });
  }

  /// 拍照/选图 → 上传（consent=true）→ 挂到待发送消息的 image ref。失败不静默。
  Future<void> _pickImage() async {
    if (_imageUploading) return;
    final xFile = await ImagePicker().pickImage(source: ImageSource.camera, imageQuality: 85);
    if (xFile == null) return;
    setState(() => _imageUploading = true);
    try {
      final imageId = await ref.read(assistantApiClientProvider).uploadImage(xFile.path);
      setState(() {
        _pendingImageId = imageId;
        _imageUploading = false;
      });
    } catch (_) {
      setState(() => _imageUploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(assistantProvider);
    // 消息最新在上：新消息到达时滚动回顶部，露出最新一条回复
    final count = state.messages.length;
    if (_lastMessageCount != count) {
      _lastMessageCount = count;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scrollController.hasClients) {
          _scrollController.animateTo(
            0.0,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOut,
          );
        }
      });
    }
    return Material(
      color: const Color(0xFF17181F),
      clipBehavior: Clip.antiAlias,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            // 头部一行：标题 + 事件切换（对话/任务/确认）+ 模式 + 操作图标
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 8, 4),
              child: Row(
                children: [
                  const Icon(Icons.auto_awesome,
                      size: 16, color: Color(0xFFFFC86B)),
                  const SizedBox(width: 6),
                  const Text('创作助手',
                      style:
                          TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                  const SizedBox(width: 8),
                  _TabItem(
                      label: '对话',
                      selected: _tab == AssistantTab.chat,
                      onTap: () => _selectTab(AssistantTab.chat)),
                  const SizedBox(width: 3),
                  _TabItem(
                      label: '任务',
                      selected: _tab == AssistantTab.tasks,
                      onTap: () => _selectTab(AssistantTab.tasks)),
                  const SizedBox(width: 3),
                  _TabItem(
                      label: '确认',
                      selected: _tab == AssistantTab.tickets,
                      onTap: () => _selectTab(AssistantTab.tickets)),
                  const Spacer(),
                  Text(
                    state.mode == 'llm+rule' ? 'AI 对话' : '规则辅助',
                    style: const TextStyle(fontSize: 10, color: Colors.white54),
                  ),
                  GestureDetector(
                    onTap: state.sending
                        ? null
                        : () =>
                            ref.read(assistantProvider.notifier).newSession(),
                    child: const Icon(Icons.add_comment_outlined, size: 16),
                  ),
                  const SizedBox(width: 4),
                  GestureDetector(
                    onTap: () => Navigator.of(context).pop(),
                    child: const Icon(Icons.close, size: 16),
                  ),
                ],
              ),
            ),
            if (_tab == AssistantTab.chat) ...[
              // 输入区置顶：键盘弹出时输入行始终在键盘之上
              ListenableBuilder(
                listenable: _voice,
                builder: (context, _) {
                  return Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_voice.talkError != null)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
                          child: Text(_voice.talkError!,
                              style: TextStyle(
                                  fontSize: 11.5,
                                  color:
                                      Theme.of(context).colorScheme.error,
                                  height: 1.35)),
                        ),
                      _Composer(
                        controller: _input,
                        sending: state.sending,
                        onSend: _submit,
                        voice: _voice,
                        onPickImage: _pickImage,
                        imageUploading: _imageUploading,
                        hasImage: _pendingImageId != null,
                      ),
                    ],
                  );
                },
              ),
              // 错误提示（紧凑，仅对话页）
              if (state.error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 0),
                  child: Text(
                    userVisibleText(state.error!),
                    style: const TextStyle(
                        color: Colors.orangeAccent, fontSize: 11.5),
                  ),
                ),
            ],
            // 内容区：固定高度，内部滚动（面板高度恒定，不跳动）
            Expanded(
              child: Builder(builder: (context) {
                if (_tab == AssistantTab.chat) {
                  // 最新在上：新消息置顶，自动滚动回顶部展示最新回复
                  final messages = state.messages
                      .where((message) => message.role != 'tool')
                      .toList()
                      .reversed
                      .toList();
                  return messages.isEmpty
                      ? _ChatWelcomeCompact(onPrompt: _submit)
                      : ListView.builder(
                          controller: _scrollController,
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                          itemCount: messages.length,
                          itemBuilder: (_, index) =>
                              _MessageBubble(message: messages[index]),
                        );
                } else if (_tab == AssistantTab.tasks) {
                  return RefreshIndicator(
                    onRefresh: () =>
                        ref.read(assistantProvider.notifier).refreshTasks(),
                    child: state.tasks.isEmpty
                        ? const Padding(
                            padding:
                                EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                            child: Text('还没有进行中的创作任务',
                                style: TextStyle(
                                    color: Colors.white54, fontSize: 13)),
                          )
                        : ListView.builder(
                            padding: const EdgeInsets.all(16),
                            itemCount: state.tasks.length,
                            itemBuilder: (_, index) =>
                                _TaskTile(task: state.tasks[index]),
                          ),
                  );
                } else {
                  return RefreshIndicator(
                    onRefresh: () =>
                        ref.read(assistantProvider.notifier).refreshTickets(),
                    child: state.tickets.isEmpty
                        ? const Padding(
                            padding:
                                EdgeInsets.symmetric(horizontal: 16, vertical: 16),
                            child: Text('暂无待确认事项',
                                style: TextStyle(
                                    color: Colors.white54, fontSize: 13)),
                          )
                        : ListView.builder(
                            padding: const EdgeInsets.all(16),
                            itemCount: state.tickets.length,
                            itemBuilder: (_, index) => _TicketCard(
                              ticket: state.tickets[index],
                              busy: state.busyTicketIds
                                  .contains(state.tickets[index].id),
                            ),
                          ),
                  );
                }
              }),
            ),
          ],
        ),
      ),
    );
  }
}

class _TabItem extends StatelessWidget {
  const _TabItem(
      {required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? const Color(0xFF3A3D4E) : null,
          borderRadius: BorderRadius.circular(14),
          border: selected ? null : Border.all(color: Colors.white12),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 13,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
            color: selected ? Colors.white : Colors.white54,
          ),
        ),
      ),
    );
  }
}

class _ChatWelcomeCompact extends StatelessWidget {
  const _ChatWelcomeCompact({required this.onPrompt});
  final void Function(String) onPrompt;

  static const _prompts = [
    '现在有哪些任务在进行？',
    '帮我找一首适合深夜通勤的歌',
    '有哪些需要我确认的操作？',
  ];

  @override
  Widget build(BuildContext context) {
    return ListView(
      shrinkWrap: true,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      children: [
        const Text('把创作交给你，流程我来盯',
            style: TextStyle(fontSize: 13, color: Colors.white70)),
        const SizedBox(height: 8),
        ..._prompts.map((p) =>
            _PromptChip(label: p, onTap: () => onPrompt(p))),
      ],
    );
  }
}

class _PromptChip extends StatelessWidget {
  const _PromptChip({required this.label, required this.onTap});
  final String label;
  final void Function() onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: const Color(0xFF23242E),
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Padding(
            padding:
                const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Expanded(
                  child: Text(
                      label,
                      style: const TextStyle(
                          fontSize: 12, color: Colors.white70),
                      overflow: TextOverflow.ellipsis),
                ),
                const SizedBox(width: 4),
                const Icon(Icons.north_east, size: 12, color: Colors.white38),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer(
      {required this.controller,
      required this.sending,
      required this.onSend,
      this.voice,
      this.onPickImage,
      this.imageUploading = false,
      this.hasImage = false});

  final TextEditingController controller;
  final bool sending;
  final void Function() onSend;
  final AssistantVoiceController? voice;
  final void Function()? onPickImage;
  final bool imageUploading;
  final bool hasImage;

  @override
  Widget build(BuildContext context) {
    final v = voice;
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 6, 10, 8),
      child: Row(
        children: [
          if (onPickImage != null) ...[
            _RoundButton(
              tooltip: hasImage ? '已附上照片' : '拍照',
              onPressed: imageUploading ? null : onPickImage,
              child: imageUploading
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.camera_alt_outlined, size: 18),
            ),
            const SizedBox(width: 6),
          ],
          Expanded(
            child: TextField(
              controller: controller,
              minLines: 1,
              maxLines: 2,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => onSend(),
              style: const TextStyle(fontSize: 13.5, color: Colors.white),
              decoration: const InputDecoration(
                  hintText: '说说你想怎么改…',
                  border: OutlineInputBorder(),
                  isDense: true),
            ),
          ),
          const SizedBox(width: 6),
          // 合并按钮：输入有文字=发送；空=语音（点按开始/停止识别）
          if (v != null)
            _SendVoiceButton(
                controller: controller, voice: v, sending: sending, onSend: onSend)
          else
            _RoundButton(
              tooltip: '发送',
              onPressed: sending ? null : onSend,
              child: sending
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.send, size: 18),
            ),
        ],
      ),
    );
  }
}

/// 发送/语音合并按钮：输入框有文字时是「发送」；空时是「语音」（点按开始识别，
/// 再点按停止并把终稿写回输入框）。
class _SendVoiceButton extends StatelessWidget {
  const _SendVoiceButton({
    required this.controller,
    required this.voice,
    required this.sending,
    required this.onSend,
  });

  final TextEditingController controller;
  final AssistantVoiceController voice;
  final bool sending;
  final void Function() onSend;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final hasText = controller.text.trim().isNotEmpty;
        return ListenableBuilder(
          listenable: voice,
          builder: (context, _) {
            final listening = voice.listening;
            if (hasText) {
              return _RoundButton(
                tooltip: '发送',
                onPressed: sending ? null : onSend,
                child: sending
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.send, size: 18),
              );
            }
            // 空 → 语音：点按开始 / 再点按停止
            return GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => listening ? voice.stopTalk() : voice.startTalk(),
              child: Container(
                width: 40,
                height: 40,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: listening
                      ? Theme.of(context).colorScheme.errorContainer
                      : Theme.of(context).colorScheme.primaryContainer,
                ),
                child: Icon(
                    listening ? Icons.graphic_eq_rounded : Icons.mic_rounded,
                    size: 18,
                    color: Colors.white),
              ),
            );
          },
        );
      },
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton(
      {required this.onPressed, required this.child, this.tooltip});

  final void Function()? onPressed;
  final Widget child;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip ?? '',
      child: GestureDetector(
        onTap: onPressed,
        child: Container(
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Theme.of(context).colorScheme.primaryContainer,
          ),
          child: child,
        ),
      ),
    );
  }
}

class _MessageBubble extends ConsumerWidget {
  const _MessageBubble({required this.message});
  final AssistantMessage message;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isUser = message.role == 'user';
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints:
            BoxConstraints(maxWidth: MediaQuery.of(context).size.width * .84),
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
            color: isUser ? scheme.primaryContainer : const Color(0xFF262833),
            borderRadius: BorderRadius.circular(14)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(userVisibleText(message.content),
                style: TextStyle(
                    color: isUser ? scheme.onPrimaryContainer : Colors.white,
                    fontSize: 13.5,
                    height: 1.45)),
            if (message.ticket != null) ...[
              const SizedBox(height: 8),
              _TicketCard(ticket: message.ticket!),
            ] else if (!isUser &&
                message.id.isNotEmpty &&
                !message.id.startsWith('reply_'))
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextButton(
                      onPressed: () => ref
                          .read(assistantProvider.notifier)
                          .feedback(message.id, 'accepted'),
                      child: const Text('有用')),
                  TextButton(
                      onPressed: () => ref
                          .read(assistantProvider.notifier)
                          .feedback(message.id, 'dismissed'),
                      child: const Text('没用')),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _TaskTile extends StatelessWidget {
  const _TaskTile({required this.task});
  final AssistantTask task;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: const Icon(Icons.graphic_eq),
        title: Text(task.title.isEmpty ? '创作任务' : task.title),
        subtitle: Text('${task.status} · ${task.progress}%'),
        trailing: const Icon(Icons.chevron_right),
        onTap: () {
          if (task.status == 'done' &&
              (task.resultWorkId?.isNotEmpty ?? false)) {
            Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => WorkDetailPage(workId: task.resultWorkId!)));
          } else {
            ProgressPage.push(context, task.id,
                title: task.title.isEmpty ? '创作任务' : task.title);
          }
        },
      ),
    );
  }
}

class _TicketCard extends ConsumerWidget {
  const _TicketCard({required this.ticket, this.busy = false});
  final AssistantTicket ticket;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final diff = ticket.meta['diff']?.toString();
    return Card(
      margin: const EdgeInsets.only(top: 6),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(ticket.actionLabel,
                style: const TextStyle(fontWeight: FontWeight.w700)),
            if (diff != null && diff.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(userVisibleText(diff),
                  style: const TextStyle(color: Colors.white70)),
            ],
            if (ticket.reply?.isNotEmpty == true) ...[
              const SizedBox(height: 6),
              Text(userVisibleText(ticket.reply!),
                  style: const TextStyle(color: Colors.white70, height: 1.4)),
            ],
            const SizedBox(height: 6),
            Text('${ticket.minutes} 分钟 · ${ticket.status}',
                style: const TextStyle(fontSize: 11, color: Colors.white54)),
            if (ticket.pending) ...[
              const SizedBox(height: 8),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                      onPressed: busy
                          ? null
                          : () => ref
                              .read(assistantProvider.notifier)
                              .denyTicket(ticket),
                      child: const Text('拒绝')),
                  FilledButton(
                      onPressed: busy || !ticket.canConfirm
                          ? null
                          : () => ref
                              .read(assistantProvider.notifier)
                              .confirmTicket(ticket),
                      child: busy
                          ? const SizedBox(
                              width: 14,
                              height: 14,
                              child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('确认执行')),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class AssistantSuggestionCard extends ConsumerWidget {
  const AssistantSuggestionCard({
    super.key,
    required this.title,
    required this.prompt,
    this.icon = Icons.auto_awesome,
  });

  final String title;
  final String prompt;
  final IconData icon;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rc = ref.watch(remoteConfigProvider);
    if (rc != null && !rc.assistantCore) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Material(
        color: Colors.white.withValues(alpha: .025),
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => showGlobalAssistant(context, prompt: prompt),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
            child: Row(
              children: [
                Icon(icon, size: 14, color: const Color(0xFFFFC86B)),
                const SizedBox(width: 7),
                Expanded(
                    child: Text(title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 12, color: Colors.white70))),
                const Icon(Icons.chevron_right,
                    size: 14, color: Colors.white24),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
