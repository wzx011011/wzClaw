class SessionTaskState {
  final String sessionId;
  final String runId;
  final String status;
  final String? phase;
  final String? message;
  final int startedAt;
  final int updatedAt;
  final int? completedAt;
  final String? error;
  final bool? recoverable;
  final int? persistedMessageCount;

  const SessionTaskState({
    required this.sessionId,
    required this.runId,
    required this.status,
    this.phase,
    this.message,
    required this.startedAt,
    required this.updatedAt,
    this.completedAt,
    this.error,
    this.recoverable,
    this.persistedMessageCount,
  });

  factory SessionTaskState.fromJson(Map<String, dynamic> json) {
    return SessionTaskState(
      sessionId: json['sessionId'] as String? ?? '',
      runId: json['runId'] as String? ?? '',
      status: json['status'] as String? ?? 'idle',
      phase: json['phase'] as String?,
      message: json['message'] as String?,
      startedAt: (json['startedAt'] as num?)?.toInt() ?? 0,
      updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      completedAt: (json['completedAt'] as num?)?.toInt(),
      error: json['error'] as String?,
      recoverable: json['recoverable'] as bool?,
      persistedMessageCount: (json['persistedMessageCount'] as num?)?.toInt(),
    );
  }

  bool get isActive => const {
        'starting',
        'running',
        'waiting_permission',
        'waiting_user',
        'stopping',
      }.contains(status);

  bool get isTerminal => const {
        'completed',
        'failed',
        'cancelled',
        'interrupted',
      }.contains(status);

  bool get isWaitingForUser => status == 'waiting_permission' || status == 'waiting_user';

  bool get canSend => !isActive;

  SessionTaskState copyWith({
    String? status,
    String? phase,
    String? message,
    int? updatedAt,
    int? completedAt,
    String? error,
    bool? recoverable,
    int? persistedMessageCount,
  }) {
    return SessionTaskState(
      sessionId: sessionId,
      runId: runId,
      status: status ?? this.status,
      phase: phase ?? this.phase,
      message: message ?? this.message,
      startedAt: startedAt,
      updatedAt: updatedAt ?? this.updatedAt,
      completedAt: completedAt ?? this.completedAt,
      error: error ?? this.error,
      recoverable: recoverable ?? this.recoverable,
      persistedMessageCount: persistedMessageCount ?? this.persistedMessageCount,
    );
  }
}
