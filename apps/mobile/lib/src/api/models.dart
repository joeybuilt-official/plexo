// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Domain types crossing the API boundary. Kept framework-free (plain Dart) so
// screens and the client share one vocabulary. Field sets mirror the API
// contracts in apps/api/src/routes/{workspaces,tasks,conversations,chat}.ts.

class PlexoUser {
  const PlexoUser({required this.id, required this.email, this.name, this.image});

  final String id;
  final String email;
  final String? name;
  final String? image;

  factory PlexoUser.fromJson(Map<String, dynamic> json) => PlexoUser(
        id: json["id"] as String,
        email: json["email"] as String,
        name: json["name"] as String?,
        image: json["image"] as String?,
      );
}

/// `GET /api/v1/workspaces` item (WorkspaceSummary: id, name, ownerId, createdAt).
class Workspace {
  const Workspace({
    required this.id,
    required this.name,
    this.ownerId,
    this.createdAt,
  });

  final String id;
  final String name;
  final String? ownerId;
  final DateTime? createdAt;

  factory Workspace.fromJson(Map<String, dynamic> json) => Workspace(
        id: json["id"] as String,
        name: (json["name"] as String?)?.trim().isNotEmpty == true
            ? json["name"] as String
            : "(unnamed workspace)",
        ownerId: json["ownerId"] as String?,
        createdAt: _parseDate(json["createdAt"]),
      );
}

/// `GET /api/v1/tasks` item — a full task row (subset the app renders).
class Task {
  const Task({
    required this.id,
    required this.workspaceId,
    required this.type,
    required this.status,
    required this.source,
    this.description,
    this.outcomeSummary,
    this.failureReason,
    this.qualityScore,
    this.costUsd,
    this.routedProvider,
    this.routedModel,
    this.createdAt,
    this.completedAt,
  });

  final String id;
  final String workspaceId;
  final String type;
  final String status;
  final String source;
  final String? description;
  final String? outcomeSummary;
  final String? failureReason;
  final double? qualityScore;
  final double? costUsd;
  final String? routedProvider;
  final String? routedModel;
  final DateTime? createdAt;
  final DateTime? completedAt;

  factory Task.fromJson(Map<String, dynamic> json) {
    final ctx = json["context"];
    final description = ctx is Map ? ctx["description"] as String? : null;
    return Task(
      id: json["id"] as String,
      workspaceId: json["workspaceId"] as String,
      type: json["type"] as String? ?? "automation",
      status: json["status"] as String? ?? "queued",
      source: json["source"] as String? ?? "dashboard",
      description: description ?? ctx?["message"] as String?,
      outcomeSummary: json["outcomeSummary"] as String?,
      failureReason: json["failureReason"] as String?,
      qualityScore: _toDouble(json["qualityScore"]),
      costUsd: _toDouble(json["costUsd"]) ?? _toDouble(json["costUsdNumeric"]),
      routedProvider: json["routedProvider"] as String?,
      routedModel: json["routedModel"] as String?,
      createdAt: _parseDate(json["createdAt"]),
      completedAt: _parseDate(json["completedAt"]),
    );
  }

  bool get isActive => status == "queued" || status == "claimed" || status == "running";
  bool get isTerminal => !isActive && status != "awaiting_approval";
}

/// One step in `GET /api/v1/tasks/:id` (`steps[]`).
class TaskStep {
  const TaskStep({
    required this.id,
    required this.stepNumber,
    required this.state,
    this.stepType,
    this.outcome,
    this.error,
    this.startedAt,
    this.completedAt,
  });

  final String id;
  final int stepNumber;
  final String state;
  final String? stepType;
  final String? outcome;
  final String? error;
  final DateTime? startedAt;
  final DateTime? completedAt;

  factory TaskStep.fromJson(Map<String, dynamic> json) => TaskStep(
        id: json["id"] as String,
        stepNumber: (json["stepNumber"] as num?)?.toInt() ?? 0,
        state: json["state"] as String? ?? "pending",
        stepType: json["stepType"] as String?,
        outcome: json["outcome"] as String?,
        error: json["error"] as String?,
        startedAt: _parseDate(json["startedAt"]),
        completedAt: _parseDate(json["completedAt"]),
      );
}

class TaskDetail {
  const TaskDetail({required this.task, required this.steps});

  final Task task;
  final List<TaskStep> steps;

  factory TaskDetail.fromJson(Map<String, dynamic> json) => TaskDetail(
        task: Task.fromJson(Map<String, dynamic>.from(json["task"] as Map)),
        steps: ((json["steps"] as List?) ?? const [])
            .whereType<Map>()
            .map((s) => TaskStep.fromJson(Map<String, dynamic>.from(s)))
            .toList(),
      );
}

/// `GET /api/v1/conversations` item (subset).
class Conversation {
  const Conversation({
    required this.id,
    required this.message,
    required this.status,
    this.reply,
    this.errorMsg,
    this.intent,
    this.taskId,
    this.sessionId,
    this.createdAt,
  });

  final String id;
  final String message;
  final String status;
  final String? reply;
  final String? errorMsg;
  final String? intent;
  final String? taskId;
  final String? sessionId;
  final DateTime? createdAt;

  factory Conversation.fromJson(Map<String, dynamic> json) => Conversation(
        id: json["id"] as String,
        message: json["message"] as String? ?? "",
        status: json["status"] as String? ?? "complete",
        reply: json["reply"] as String?,
        errorMsg: json["errorMsg"] as String?,
        intent: json["intent"] as String?,
        taskId: json["taskId"] as String?,
        sessionId: json["sessionId"] as String?,
        createdAt: _parseDate(json["createdAt"]),
      );
}

/// Result of `POST /api/v1/chat/message`. The API returns HTTP 200 for a soft AI
/// failure (`status: 'error'`), so the app branches on `kind`, not status code.
enum ChatKind { complete, taskQueued, confirmAction, error }

class ChatResult {
  const ChatResult({
    required this.kind,
    this.reply,
    this.model,
    this.taskId,
    this.intent,
    this.description,
    this.fixHint,
  });

  final ChatKind kind;
  final String? reply;
  final String? model;
  final String? taskId;

  /// `confirm_action` only.
  final String? intent;
  final String? description;

  /// `error` only — a human hint (fixLabel) when the API supplied one.
  final String? fixHint;

  factory ChatResult.fromJson(Map<String, dynamic> json) {
    final status = json["status"] as String?;
    switch (status) {
      case "task_queued":
        return ChatResult(
          kind: ChatKind.taskQueued,
          taskId: json["taskId"] as String?,
          reply: json["reply"] as String?,
          model: json["model"] as String?,
        );
      case "confirm_action":
        return ChatResult(
          kind: ChatKind.confirmAction,
          intent: json["intent"] as String?,
          description: json["description"] as String?,
          model: json["model"] as String?,
        );
      case "error":
        return ChatResult(
          kind: ChatKind.error,
          reply: json["reply"] as String? ?? "The request failed.",
          fixHint: json["fixLabel"] as String?,
          model: json["model"] as String?,
        );
      case "complete":
      default:
        // The credential-install path omits `status` entirely; treat any reply
        // without a known status as a completed turn.
        return ChatResult(
          kind: ChatKind.complete,
          reply: json["reply"] as String? ?? "",
          model: json["model"] as String?,
        );
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Timestamps from `timestamp` (tz-naive) columns arrive without an offset;
/// parse them as UTC so relative labels are stable across devices.
DateTime? _parseDate(Object? raw) {
  if (raw is! String || raw.isEmpty) return null;
  final hasZone = raw.endsWith("Z") || RegExp(r"[+-]\d\d:?\d\d$").hasMatch(raw);
  return DateTime.tryParse(hasZone ? raw : "${raw}Z")?.toLocal();
}

double? _toDouble(Object? raw) {
  if (raw is num) return raw.toDouble();
  if (raw is String) return double.tryParse(raw);
  return null;
}

/// Raised for an expected API failure (bad creds, expired session, transport).
/// The message is safe to show the user.
class AuthException implements Exception {
  const AuthException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Raised for any other API failure. [message] is user-safe; [code] is the
/// machine-readable error code when the API supplied one.
class ApiException implements Exception {
  const ApiException(this.message, {this.code, this.statusCode});
  final String message;
  final String? code;
  final int? statusCode;
  @override
  String toString() => message;
}
