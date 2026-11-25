import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/state.dart';
import '../create/progress_page.dart';
import '../library/work_detail_page.dart';
import 'assistant_models.dart';
import 'assistant_state.dart';

Future<void> showGlobalAssistant(BuildContext context,
    {AssistantTab tab = AssistantTab.chat, String? prompt}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (ctx) {
      final media = MediaQuery.of(ctx);
      final heightFactor = tab == AssistantTab.chat ? .56 : .68;
      return Align(
        alignment: Alignment.bottomCenter,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: 440,
            maxHeight:
                (media.size.height - media.viewInsets.bottom) * heightFactor,
          ),
          child: AssistantPanel(initialTab: tab, initialPrompt: prompt),
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
      {super.key, this.initialTab = AssistantTab.chat, this.initialPrompt});

  final AssistantTab initialTab;
  final String? initialPrompt;

  @override
  ConsumerState<AssistantPanel> createState() => _AssistantPanelState();
}

class _AssistantPanelState extends ConsumerState<AssistantPanel> {
  late AssistantTab _tab = widget.initialTab;
  final _input = TextEditingController();
  bool _attachContext = true;

  @override
  void initState() {
    super.initState();
    final prompt = widget.initialPrompt?.trim();
    if (prompt != null && prompt.isNotEmpty) {
      _input.text = prompt;
    }
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  void _submit([String? quick]) {
    final text = (quick ?? _input.text).trim();
    if (text.isEmpty) return;
    _input.clear();
    ref
        .read(assistantProvider.notifier)
        .send(text, attachContext: _attachContext);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(assistantProvider);
    final assistantContext = ref.watch(assistantContextProvider);
    return Material(
      color: const Color(0xFF17181F),
      clipBehavior: Clip.antiAlias,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
      child: SafeArea(
        top: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 12, 10, 8),
              child: Row(
                children: [
                  const Icon(Icons.auto_awesome, color: Color(0xFFFFC86B)),
                  const SizedBox(width: 8),
                  const Expanded(
                    child: Text(
                      '创作助手',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
                    ),
                  ),
                  Text(
                    state.mode == 'llm+rule' ? 'AI 对话' : '规则辅助',
                    style: const TextStyle(fontSize: 11, color: Colors.white54),
                  ),
                  IconButton(
                    tooltip: '新会话',
                    onPressed: state.sending
                        ? null
                        : () =>
                            ref.read(assistantProvider.notifier).newSession(),
                    icon: const Icon(Icons.add_comment_outlined),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            SegmentedButton<AssistantTab>(
              segments: const [
                ButtonSegment(value: AssistantTab.chat, label: Text('对话')),
                ButtonSegment(value: AssistantTab.tasks, label: Text('任务')),
                ButtonSegment(value: AssistantTab.tickets, label: Text('确认')),
              ],
              selected: {_tab},
              onSelectionChanged: (value) => setState(() => _tab = value.first),
            ),
            const SizedBox(height: 8),
            if (_tab == AssistantTab.chat) ...[
              _ContextBar(
                context: assistantContext,
                attached: _attachContext,
                onToggle: () =>
                    setState(() => _attachContext = !_attachContext),
              ),
              if (state.error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Text(
                    state.error!,
                    style: const TextStyle(color: Colors.orangeAccent),
                  ),
                ),
              Expanded(
                child: Builder(builder: (context) {
                  final messages = state.messages
                      .where((message) => message.role != 'tool')
                      .toList();
                  return messages.isEmpty
                      ? _ChatWelcome(onPrompt: _submit)
                      : ListView.builder(
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                          itemCount: messages.length,
                          itemBuilder: (_, index) =>
                              _MessageBubble(message: messages[index]),
                        );
                }),
              ),
              _Composer(
                controller: _input,
                sending: state.sending,
                onSend: _submit,
              ),
            ] else if (_tab == AssistantTab.tasks)
              Expanded(
                child: RefreshIndicator(
                  onRefresh: () =>
                      ref.read(assistantProvider.notifier).refreshTasks(),
                  child: state.tasks.isEmpty
                      ? const Center(child: Text('还没有进行中的创作任务'))
                      : ListView.builder(
                          padding: const EdgeInsets.all(16),
                          itemCount: state.tasks.length,
                          itemBuilder: (_, index) =>
                              _TaskTile(task: state.tasks[index]),
                        ),
                ),
              )
            else
              Expanded(
                child: RefreshIndicator(
                  onRefresh: () =>
                      ref.read(assistantProvider.notifier).refreshTickets(),
                  child: state.tickets.isEmpty
                      ? const Center(child: Text('暂无待确认事项'))
                      : ListView.builder(
                          padding: const EdgeInsets.all(16),
                          itemCount: state.tickets.length,
                          itemBuilder: (_, index) => _TicketCard(
                            ticket: state.tickets[index],
                            busy: state.busyTicketIds
                                .contains(state.tickets[index].id),
                          ),
                        ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ContextBar extends StatelessWidget {
  const _ContextBar(
      {required this.context, required this.attached, required this.onToggle});

  final AssistantContext context;
  final bool attached;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext buildContext) {
    final refs = attached ? context.refs : const <AssistantRef>[];
    return Container(
      width: double.infinity,
      color: const Color(0xFF1E202A),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Row(
        children: [
          const Icon(Icons.link, size: 15, color: Colors.white54),
          const SizedBox(width: 6),
          Expanded(
              child: Text(
                  refs.isEmpty
                      ? '未附带上下文，可继续问通用问题'
                      : refs.map((r) => '${r.label} ${r.id}').join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: Colors.white70))),
          TextButton(onPressed: onToggle, child: Text(attached ? '脱离' : '附带')),
        ],
      ),
    );
  }
}

class _ChatWelcome extends StatelessWidget {
  const _ChatWelcome({required this.onPrompt});
  final void Function(String) onPrompt;

  @override
  Widget build(BuildContext context) {
    const prompts = [
      '现在有哪些任务在进行？',
      '帮我找一首适合深夜通勤的歌',
      '解释一下当前作品的创作思路',
      '有哪些需要我确认的操作？',
    ];
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Icon(Icons.auto_awesome, size: 42, color: Color(0xFFFFC86B)),
        const SizedBox(height: 12),
        const Text('把创作交给你，流程我来盯',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        const SizedBox(height: 6),
        const Text('我可以查任务、找作品、解释当前上下文。涉及修改或付费时，会先给你一张确认票。',
            style: TextStyle(color: Colors.white70, height: 1.5)),
        const SizedBox(height: 18),
        ...prompts.map((p) => Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                  title: Text(p, style: const TextStyle(fontSize: 13)),
                  trailing: const Icon(Icons.north_east, size: 16),
                  onTap: () => onPrompt(p)),
            )),
      ],
    );
  }
}

class _Composer extends StatelessWidget {
  const _Composer(
      {required this.controller, required this.sending, required this.onSend});

  final TextEditingController controller;
  final bool sending;
  final void Function() onSend;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              minLines: 1,
              maxLines: 4,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => onSend(),
              decoration: const InputDecoration(
                  hintText: '说说你想怎么改…',
                  border: OutlineInputBorder(),
                  isDense: true),
            ),
          ),
          const SizedBox(width: 8),
          IconButton.filled(
              onPressed: sending ? null : onSend,
              icon: sending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.send)),
        ],
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
        margin: const EdgeInsets.symmetric(vertical: 5),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
            color: isUser ? scheme.primaryContainer : const Color(0xFF262833),
            borderRadius: BorderRadius.circular(14)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(message.content,
                style: TextStyle(
                    color: isUser ? scheme.onPrimaryContainer : Colors.white,
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
              Text(diff, style: const TextStyle(color: Colors.white70)),
            ],
            if (ticket.reply?.isNotEmpty == true) ...[
              const SizedBox(height: 6),
              Text(ticket.reply!,
                  style: const TextStyle(color: Colors.white70, height: 1.4)),
            ],
            const SizedBox(height: 6),
            Text(
                '${ticket.credits} ⚡ · ${ticket.minutes} 分钟 · ${ticket.status}',
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
