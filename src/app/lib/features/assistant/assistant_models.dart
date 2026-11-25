class AssistantRef {
  const AssistantRef(this.type, this.id);

  final String type;
  final String id;

  Map<String, dynamic> toJson() => {'type': type, 'id': id};

  String get label => switch (type) {
        'work' => '作品',
        'intent' => '灵感卡',
        'job' => '任务',
        'project' => 'MV 项目',
        'shot' => '镜头',
        'persona' => '声音人格',
        _ => type,
      };

  factory AssistantRef.fromMap(Map map) =>
      AssistantRef('${map['type'] ?? ''}', '${map['id'] ?? ''}');
}

class AssistantContext {
  const AssistantContext({
    this.surface = 'create',
    this.refs = const [],
    this.title = '',
  });

  final String surface;
  final List<AssistantRef> refs;
  final String title;
}

class AssistantMessage {
  const AssistantMessage({
    required this.id,
    required this.seq,
    required this.role,
    required this.content,
    this.meta = const {},
    this.clientMsgId,
    this.ticket,
  });

  final String id;
  final int seq;
  final String role;
  final String content;
  final Map meta;
  final String? clientMsgId;
  final AssistantTicket? ticket;

  factory AssistantMessage.fromMap(Map map) => AssistantMessage(
        id: '${map['id'] ?? ''}',
        seq: _asInt(map['seq']),
        role: '${map['role'] ?? 'assistant'}',
        content: '${map['content'] ?? map['reply'] ?? ''}',
        meta: (map['meta'] as Map?) ?? const {},
        clientMsgId: map['client_msg_id']?.toString(),
        ticket: map['ticket'] is Map
            ? AssistantTicket.fromMap(map['ticket'] as Map)
            : null,
      );
}

class AssistantMessagePage {
  const AssistantMessagePage(this.messages, this.nextSeq);

  final List<AssistantMessage> messages;
  final int nextSeq;

  factory AssistantMessagePage.fromMap(Map map) => AssistantMessagePage(
        (map['messages'] as List? ?? const [])
            .whereType<Map>()
            .map(AssistantMessage.fromMap)
            .toList(),
        _asInt(map['next_seq']),
      );
}

class AssistantMessageResult {
  const AssistantMessageResult({
    required this.sessionId,
    required this.message,
    required this.reply,
    this.ticket,
    this.meta = const {},
  });

  final String sessionId;
  final AssistantMessage message;
  final String reply;
  final AssistantTicket? ticket;
  final Map meta;

  factory AssistantMessageResult.fromMap(Map map) => AssistantMessageResult(
        sessionId: '${map['session_id'] ?? ''}',
        message: AssistantMessage.fromMap(
            (map['message'] as Map?) ?? {'role': 'user', 'content': ''}),
        reply: '${map['reply'] ?? ''}',
        ticket: map['ticket'] is Map
            ? AssistantTicket.fromMap(map['ticket'] as Map)
            : null,
        meta: (map['meta'] as Map?) ?? const {},
      );
}

class AssistantTicket {
  const AssistantTicket({
    required this.id,
    required this.action,
    required this.status,
    this.sessionId,
    this.subjectType,
    this.subjectId,
    this.ver,
    this.hash,
    this.credits = 0,
    this.minutes = 0,
    this.jobId,
    this.reply,
    this.meta = const {},
    this.createdAt,
    this.expiresAt,
  });

  final String id;
  final String action;
  final String status;
  final String? sessionId;
  final String? subjectType;
  final String? subjectId;
  final String? ver;
  final String? hash;
  final int credits;
  final int minutes;
  final String? jobId;
  final String? reply;
  final Map meta;
  final String? createdAt;
  final String? expiresAt;

  bool get pending => status == 'pending';
  bool get canConfirm =>
      pending && (ver?.isNotEmpty ?? false) && (hash?.isNotEmpty ?? false);

  String get actionLabel => switch (action) {
        'music.set_title' => '修改作品标题',
        'music.set_card' => '调整灵感卡',
        'music.adjust_params' => '微调这首作品',
        'mv.shot_reshoot' => '重新拍摄镜头',
        _ => action,
      };

  factory AssistantTicket.fromMap(Map map) {
    final est = map['est'] as Map?;
    final meta = Map<String, dynamic>.from(map['meta'] as Map? ?? const {});
    final diff = map['diff'] ?? meta['diff'];
    if (diff != null) meta['diff'] = diff;
    return AssistantTicket(
      id: '${map['ticket_id'] ?? map['id'] ?? ''}',
      action: '${map['action'] ?? ''}',
      status: '${map['status'] ?? 'pending'}',
      sessionId: map['session_id']?.toString(),
      subjectType: map['subject_type']?.toString(),
      subjectId: map['subject_id']?.toString(),
      ver: map['ver']?.toString(),
      hash: map['hash']?.toString(),
      credits: _asInt(est?['credits'] ?? map['est_credits']),
      minutes: _asInt(est?['minutes'] ?? map['est_minutes']),
      jobId: map['job_id']?.toString(),
      reply: map['reply']?.toString(),
      meta: meta,
      createdAt: map['created_at']?.toString(),
      expiresAt: (map['expires_at'] ?? map['ttl_expire_at'])?.toString(),
    );
  }
}

class AssistantTask {
  const AssistantTask({
    required this.id,
    required this.status,
    this.title = '',
    this.progress = 0,
    this.updatedAt,
    this.resultWorkId,
    this.creditsCost = 0,
  });

  final String id;
  final String status;
  final String title;
  final int progress;
  final String? updatedAt;
  final String? resultWorkId;
  final int creditsCost;

  factory AssistantTask.fromMap(Map map) => AssistantTask(
        id: '${map['id'] ?? ''}',
        status: '${map['status'] ?? ''}',
        title: '${map['title'] ?? ''}',
        progress: _asInt(map['progress']),
        updatedAt: map['updated_at']?.toString(),
        resultWorkId: map['result_work_id']?.toString(),
        creditsCost: _asInt(map['credits_cost']),
      );
}

class AssistantEvent {
  const AssistantEvent(this.seq, this.type, this.payload);

  final int seq;
  final String type;
  final Map payload;
}

class AssistantEventPage {
  const AssistantEventPage(this.items, this.nextSeq);

  final List<AssistantEvent> items;
  final int nextSeq;

  factory AssistantEventPage.fromMap(Map map) => AssistantEventPage(
        (map['items'] as List? ?? const []).whereType<Map>().map((raw) {
          final event = (raw['event'] as Map?) ?? raw;
          return AssistantEvent(
            _asInt(raw['seq']),
            '${event['type'] ?? raw['type'] ?? ''}',
            (event['payload'] as Map?) ?? const {},
          );
        }).toList(),
        _asInt(map['next_seq']),
      );
}

class AssistantSession {
  const AssistantSession({
    required this.id,
    this.title = '',
    this.surface = 'create',
    this.refs = const [],
  });

  final String id;
  final String title;
  final String surface;
  final List<AssistantRef> refs;

  factory AssistantSession.fromMap(Map map) => AssistantSession(
        id: '${map['id'] ?? ''}',
        title: '${map['title'] ?? ''}',
        surface: '${map['surface'] ?? 'create'}',
        refs: ((map['refs'] as List?) ?? const [])
            .whereType<Map>()
            .map(AssistantRef.fromMap)
            .toList(),
      );
}

class AssistantBootstrap {
  const AssistantBootstrap({
    required this.available,
    required this.mode,
    required this.capabilities,
    this.recentSession,
    this.pendingTickets = const [],
    this.tasks = const [],
  });

  final bool available;
  final String mode;
  final Map capabilities;
  final AssistantSession? recentSession;
  final List<AssistantTicket> pendingTickets;
  final List<AssistantTask> tasks;

  bool capability(String key) => capabilities[key] == true;

  factory AssistantBootstrap.fromMap(Map map) => AssistantBootstrap(
        available: map['available'] == true,
        mode: '${map['mode'] ?? 'rule'}',
        capabilities: (map['capabilities'] as Map?) ?? const {},
        recentSession: map['recent_session'] is Map
            ? AssistantSession.fromMap(map['recent_session'] as Map)
            : null,
        pendingTickets: ((map['pending_tickets'] as List?) ?? const [])
            .whereType<Map>()
            .map(AssistantTicket.fromMap)
            .toList(),
        tasks: ((map['tasks'] as List?) ?? const [])
            .whereType<Map>()
            .map(AssistantTask.fromMap)
            .toList(),
      );
}

int _asInt(dynamic value) =>
    value is num ? value.toInt() : int.tryParse('$value') ?? 0;
