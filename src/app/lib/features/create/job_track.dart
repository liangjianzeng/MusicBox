import '../../core/models.dart';

/// 阶段状态（只用后端真实信号推导，绝不伪造进度）
enum JobStageState { pending, active, done, failed }

/// 一个阶段（进度页清单里的一行）
class JobStage {
  const JobStage(this.label, this.state, {this.hint});

  final String label;
  final JobStageState state;

  /// 该阶段的补充说明（来自后端 note 的派生文案，可为空）
  final String? hint;

  bool get isDone => state == JobStageState.done;
  bool get isActive => state == JobStageState.active;
}

/// 任务轨迹：把后端仅有的 status / progress / note 三个字段，
/// 翻译成「阶段清单 + 逐首就绪 + 当前动作」。
///
/// 后端事实（server 侧核对过）：
/// - jobs 表只有 progress/note，没有 stage/step/queue_pos/eta 字段；
/// - 音乐链真实 note：`N 个候选排队中`(3) → `已完成第 i/n 个候选`((i+1)/n*99)
///   → `转码中`(90) → done(100)；重排时 `正在重试`；
/// - dsp 链真实 note：`音频处理中`(20) → `音频处理完成`(95)；
/// - intent 链真实 note：`正在识别语音`(10)/`正在观察图片`(15) →
///   `正在理解意图`(50/55) → `意图卡已生成`(90)；
/// - transcode 子任务 note：`正在转码`(20)/`正在生成波形`(60)/`转码完成`(95)。
class JobTrack {
  JobTrack._({
    required this.status,
    required this.progress,
    required this.stages,
    required this.currentAction,
    required this.readyCount,
    required this.totalCount,
    required this.retrying,
    required this.failed,
  });

  final String status;
  final int progress;
  final List<JobStage> stages;

  /// 后端 note 逐字（为空时给诚实的兜底文案）
  final String currentAction;

  /// 逐首就绪：已完成的候选数 / 计划候选数（来自后端 note 的「已完成第 i/n」）
  final int readyCount;
  final int totalCount;

  /// 后端在自动重试（attempts < maxAttempts）
  final bool retrying;
  final bool failed;

  bool get queued => status == 'queued' || status == 'leased';
  bool get done => status == 'done';
  bool get hasPerCandidate => totalCount > 1;

  /// 从后端 job 构造。plannedCount 用客户端已知的提交数量兜底。
  factory JobTrack.from({
    required Job job,
    int? plannedCount,
    String? dspOpLabel,
  }) {
    final status = job.status;
    final progress = job.progress.clamp(0, 100);
    final note = (job.note ?? '').trim();
    final failed = status == 'failed' || status == 'canceled';
    final type = job.type;

    // 「已完成第 i/n 个候选」是逐首就绪的唯一真实来源
    final m = RegExp(r'已完成第\s*(\d+)\s*[/／]\s*(\d+)').firstMatch(note);
    final noteTotal = m?.group(2) == null ? null : int.tryParse(m!.group(2)!);
    final noteDone = m?.group(1) == null ? null : int.tryParse(m!.group(1)!);
    final total = noteTotal ??
        plannedCount ??
        job.candidates?.length ??
        1;
    final isDone = status == 'done';
    final isQueued = status == 'queued' || status == 'leased';
    final ready = isDone ? total : (noteDone ?? 0);

    final retrying = note.contains('正在重试');
    final isDsp = type == 'dsp';
    final isIntent = type.startsWith('intent');
    final isTranscode = type == 'transcode';

    JobStageState s(bool finished, {bool started = true}) {
      if (failed && started && !finished) return JobStageState.failed;
      if (finished) return JobStageState.done;
      if (failed) return JobStageState.pending;
      return started ? JobStageState.active : JobStageState.pending;
    }

    final List<JobStage> stages;
    if (isDsp) {
      stages = [
        JobStage('排队等位', s(progress > 0, started: isQueued)),
        JobStage(dspOpLabel == null ? '音频处理' : '音频处理 · $dspOpLabel',
            s(progress >= 95, started: progress > 0)),
        JobStage('交付完成', s(isDone, started: progress >= 95)),
      ];
    } else if (isIntent) {
      stages = [
        JobStage('排队等位', s(progress > 3, started: isQueued)),
        JobStage(type.contains('image') ? '看懂这张图' : '听你唱的这段',
            s(progress >= 50, started: progress > 3)),
        JobStage('编译意图卡', s(progress >= 90, started: progress >= 50)),
        JobStage('交付完成', s(isDone, started: progress >= 90)),
      ];
    } else if (isTranscode) {
      stages = [
        JobStage('排队等位', s(progress > 0, started: isQueued)),
        JobStage('转码 mp3', s(progress >= 60, started: progress > 0)),
        JobStage('生成波形', s(progress >= 95, started: progress >= 60)),
        JobStage('交付完成', s(isDone, started: progress >= 95)),
      ];
    } else {
      // 音乐生成主链（music / adjust / extend / cover / variation 都是 type=music）
      stages = [
        JobStage('排队等位', s(progress > 3, started: isQueued)),
        JobStage(
          total > 1 ? '逐首生成候选（$total 首）' : '生成候选',
          s(progress >= 90, started: progress > 3),
          hint: total > 1 ? '已出 $ready / $total 首' : null,
        ),
        JobStage('转码 mp3 与波形', s(progress >= 100 && isDone, started: progress >= 90)),
        JobStage('交付完成', s(isDone, started: progress >= 90)),
      ];
    }

    return JobTrack._(
      status: status,
      progress: progress,
      stages: stages,
      currentAction: _actionOf(status: status, note: note, type: type),
      readyCount: ready,
      totalCount: total,
      retrying: retrying,
      failed: failed,
    );
  }

  static String _actionOf({
    required String status,
    required String note,
    required String type,
  }) {
    if (note.isNotEmpty) return note; // 后端写了什么，就如实说什么
    switch (status) {
      case 'queued':
        return '已提交，正在排队等生成节点领单';
      case 'leased':
        return '节点已领单，正在预热';
      case 'running':
        return '生成中…';
      case 'done':
        return '已完成';
      case 'canceled':
        return '任务已取消';
      case 'failed':
        return '这次没成功';
      default:
        return '准备中…';
    }
  }
}
