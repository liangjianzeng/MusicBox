import 'package:flutter/material.dart';

import 'shelf_store.dart';

/// 任务要素卡：把「这次到底在按什么生成」摊开给用户看。
/// 默认只显示前 [maxCollapsed] 条，其余「看全部」展开——
/// 简约级不吓人，深度级要核对时点得开。
class TaskBriefCard extends StatefulWidget {
  const TaskBriefCard({
    super.key,
    required this.brief,
    this.maxCollapsed = 3,
    this.initiallyExpanded = false,
    this.title,
    this.trailing,
  });

  final TaskBrief brief;
  final int maxCollapsed;
  final bool initiallyExpanded;
  final String? title;
  final Widget? trailing;

  @override
  State<TaskBriefCard> createState() => _TaskBriefCardState();
}

class _TaskBriefCardState extends State<TaskBriefCard> {
  late bool _open = widget.initiallyExpanded;
  bool _factExpanded = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final rows = widget.brief.toRows();
    if (rows.isEmpty) return const SizedBox.shrink();
    final showAll = _open || rows.length <= widget.maxCollapsed;
    final shown = showAll ? rows : rows.take(widget.maxCollapsed).toList();
    final head = widget.brief.headline;

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white10),
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.assignment_outlined, size: 15, color: scheme.primary),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  widget.title ??
                      (widget.brief.action.isEmpty
                          ? '本次任务要素'
                          : '本次${widget.brief.action}要素'),
                  style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: Colors.white70),
                ),
              ),
              if (head.isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(right: 4),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: scheme.primary.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(head,
                      style: TextStyle(
                          fontSize: 11,
                          color: scheme.primary,
                          fontWeight: FontWeight.w600)),
                ),
              widget.trailing ??
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    onPressed: () => setState(() => _open = !_open),
                    icon: Icon(
                        _open
                            ? Icons.expand_less
                            : Icons.expand_more,
                        size: 20,
                        color: Colors.white38),
                    tooltip: _open ? '收起' : '看全部要素',
                  ),
            ],
          ),
          const SizedBox(height: 6),
          for (final f in shown)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 68,
                    child: Text(f.label,
                        style: const TextStyle(
                            fontSize: 12, color: Colors.white38)),
                  ),
                  Expanded(
                    child: Text(
                      _factExpanded || !f.multiline
                          ? f.value
                          : '${f.value.length > 46 ? '${f.value.substring(0, 46)}…' : f.value}'
                              '　（点开看全文）',
                      maxLines: _factExpanded || !f.multiline ? null : 2,
                      overflow: _factExpanded || !f.multiline
                          ? TextOverflow.visible
                          : TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 12.5,
                          color: Colors.white,
                          height: 1.35),
                    ),
                  ),
                ],
              ),
            ),
          if (!showAll)
            TextButton(
              onPressed: () => setState(() => _open = true),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                minimumSize: const Size(0, 30),
              ),
              child: Text('看全部 ${rows.length} 项要素',
                  style: const TextStyle(fontSize: 12)),
            )
          else if (rows.any((f) => f.multiline) && !_factExpanded)
            TextButton(
              onPressed: () => setState(() => _factExpanded = true),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                padding: EdgeInsets.zero,
                minimumSize: const Size(0, 30),
              ),
              child: const Text('展开全文', style: TextStyle(fontSize: 12)),
            ),
        ],
      ),
    );
  }
}
