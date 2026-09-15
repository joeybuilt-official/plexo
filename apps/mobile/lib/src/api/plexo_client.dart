// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo HTTP gateway (adapter). Hand-written http client against the Plexo
// API. It owns base-URL + bearer-header injection so screens never touch
// transport concerns.
//
// Auth uses better-auth's bearer plugin (ADR-0001 Phase 1): sign-in returns the
// session token via the `set-auth-token` response header; we persist it in
// secure storage and send it as `Authorization: Bearer <token>` on every call.
// All routes are same-origin under the instance base URL: /api/auth/* is the
// better-auth handler, /api/v1/* is the Plexo API.
//
// The chat endpoint can switch to Server-Sent Events when the client advertises
// `Accept: text/event-stream`; this client always sends `Accept: application/json`
// so it gets the plain JSON contract its UI is built around.

import "dart:convert";

import "package:http/http.dart" as http;

import "../state/auth_store.dart";
import "models.dart";

class PlexoClient {
  PlexoClient(this._auth, {http.Client? client}) : _http = client ?? http.Client();

  final AuthStore _auth;
  final http.Client _http;

  /// The instance the client is pointed at (for the Settings "server" row).
  String get baseUrl => _auth.baseUrl;

  /// The chat queue path can block on a description synthesis call before it
  /// queues; the reply poll long-polls up to 25s. Both need headroom.
  static const _chatTimeout = Duration(seconds: 60);
  static const _pollTimeout = Duration(seconds: 40);

  Uri _url(String path, [Map<String, String>? query]) =>
      Uri.parse("${_auth.baseUrl}$path").replace(queryParameters: query);

  Map<String, String> _headers({bool json = false}) => {
        "Accept": "application/json",
        if (json) "Content-Type": "application/json",
        if (_auth.token != null) "Authorization": "Bearer ${_auth.token}",
      };

  // ── Auth ────────────────────────────────────────────────────────────────────

  /// Sign in with email + password against [baseUrl]. On success the bearer
  /// token (from the `set-auth-token` header, or the body `token` fallback) is
  /// persisted and the authenticated user returned. Throws [AuthException] on
  /// bad credentials or transport failure.
  Future<PlexoUser> signIn({
    required String baseUrl,
    required String email,
    required String password,
  }) async {
    await _auth.setBaseUrl(baseUrl);
    final res = await _post("/api/auth/sign-in/email", {"email": email, "password": password});
    final token = res.headers["set-auth-token"] ?? _tokenFromBody(res.body);
    if (token == null || token.isEmpty) {
      throw const AuthException("Sign-in succeeded but no token was returned.");
    }
    await _auth.setToken(token);
    final user = _userFromBody(res.body);
    if (user != null) return user;
    // Some better-auth versions omit the user on sign-in; fetch it.
    final session = await getSession();
    if (session == null) throw const AuthException("Could not establish a session.");
    return session;
  }

  /// Register a new account, then (better-auth autoSignIn) persist the token.
  Future<PlexoUser> signUp({
    required String baseUrl,
    required String name,
    required String email,
    required String password,
  }) async {
    await _auth.setBaseUrl(baseUrl);
    final res = await _post(
      "/api/auth/sign-up/email",
      {"name": name, "email": email, "password": password},
    );
    final token = res.headers["set-auth-token"] ?? _tokenFromBody(res.body);
    if (token != null && token.isNotEmpty) {
      await _auth.setToken(token);
      final user = _userFromBody(res.body) ?? await getSession();
      if (user != null) return user;
    }
    // Email-verification gated instances return no token; surface that.
    throw const AuthException("Account created. Check your email to verify, then sign in.");
  }

  /// Request a password-reset email. Always resolves (no user enumeration).
  Future<void> requestPasswordReset({required String baseUrl, required String email}) async {
    await _auth.setBaseUrl(baseUrl);
    try {
      await _post("/api/auth/request-password-reset", {"email": email});
    } catch (_) {
      // Intentionally swallow — never reveal whether the address exists.
    }
  }

  /// Validate the persisted token. Returns the user, or null if unauthenticated.
  Future<PlexoUser?> getSession() async {
    if (_auth.token == null) return null;
    try {
      final res = await _http.get(_url("/api/auth/get-session"), headers: _headers());
      if (res.statusCode != 200) return null;
      return _userFromBody(res.body);
    } catch (_) {
      return null;
    }
  }

  Future<void> signOut() async {
    try {
      await _http.post(_url("/api/auth/sign-out"), headers: _headers(json: true), body: "{}");
    } catch (_) {
      // Best-effort server revoke; local clear below is what matters.
    }
    await _auth.clear();
  }

  // ── Workspaces ──────────────────────────────────────────────────────────────

  Future<List<Workspace>> listWorkspaces() async {
    final json = await _getJson("/api/v1/workspaces", null);
    final items = (json["items"] as List?) ?? const [];
    return items
        .whereType<Map>()
        .map((m) => Workspace.fromJson(Map<String, dynamic>.from(m)))
        .toList();
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────

  Future<List<Task>> listTasks(String workspaceId, {String? status}) async {
    final json = await _getJson("/api/v1/tasks", {
      "workspaceId": workspaceId,
      "status": ?status,
      "limit": "50",
    });
    final items = (json["items"] as List?) ?? const [];
    return items
        .whereType<Map>()
        .map((m) => Task.fromJson(Map<String, dynamic>.from(m)))
        .toList();
  }

  Future<TaskDetail> getTask(String taskId) async {
    final json = await _getJson("/api/v1/tasks/$taskId", null);
    return TaskDetail.fromJson(json);
  }

  Future<void> cancelTask(String taskId) async {
    await _postJson("/api/v1/tasks/$taskId/cancel", const {});
  }

  Future<void> retryTask(String taskId) async {
    await _postJson("/api/v1/tasks/$taskId/retry", const {});
  }

  // ── Conversations ───────────────────────────────────────────────────────────

  Future<List<Conversation>> listConversations(String workspaceId) async {
    final json = await _getJson("/api/v1/conversations", {
      "workspaceId": workspaceId,
      "limit": "50",
    });
    final items = (json["items"] as List?) ?? const [];
    return items
        .whereType<Map>()
        .map((m) => Conversation.fromJson(Map<String, dynamic>.from(m)))
        .toList();
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  /// Send a chat turn. Returns the parsed terminal result. Never throws for a
  /// soft AI failure (`status: 'error'`) — that comes back as [ChatKind.error].
  Future<ChatResult> sendMessage({
    required String workspaceId,
    required String message,
    required String sessionId,
    bool forceConversation = false,
  }) async {
    final json = await _postJson("/api/v1/chat/message", {
      "workspaceId": workspaceId,
      "message": message,
      "sessionId": sessionId,
      "newSession": true,
      if (forceConversation) "forceConversation": true,
    }, timeout: _chatTimeout);
    return ChatResult.fromJson(json);
  }

  /// Queue a task from a confirmed action (the `confirm_action` follow-up).
  Future<String?> executeAction({
    required String workspaceId,
    required String intent,
    required String description,
    required String sessionId,
  }) async {
    final json = await _postJson("/api/v1/chat/execute-action", {
      "workspaceId": workspaceId,
      "intent": intent,
      "description": description,
      "sessionId": sessionId,
    });
    return json["taskId"] as String?;
  }

  /// Poll for a queued task's reply. Long-polls up to ~25s server-side; a
  /// `pending` status means "still running, poll again".
  Future<String?> pollTaskReply(String taskId) async {
    final json = await _getJson("/api/v1/chat/reply/$taskId", null, timeout: _pollTimeout);
    final status = json["status"] as String?;
    if (status == "pending") return null; // caller re-polls
    return json["reply"] as String?;
  }

  // ── Transport ───────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> _getJson(
    String path,
    Map<String, String>? query, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final http.Response res;
    try {
      res = await _http.get(_url(path, query), headers: _headers()).timeout(timeout);
    } catch (_) {
      throw ApiException("Can't reach ${_auth.baseUrl}. Check your connection.");
    }
    return _decode(res, path);
  }

  Future<Map<String, dynamic>> _postJson(
    String path,
    Map<String, dynamic> body, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final http.Response res;
    try {
      res = await _http
          .post(_url(path), headers: _headers(json: true), body: jsonEncode(body))
          .timeout(timeout);
    } catch (_) {
      throw ApiException("Can't reach ${_auth.baseUrl}. Check your connection.");
    }
    return _decode(res, path);
  }

  Map<String, dynamic> _decode(http.Response res, String path) {
    Map<String, dynamic>? json;
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map) json = Map<String, dynamic>.from(decoded);
    } catch (_) {
      json = null;
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return json ?? <String, dynamic>{};
    }
    // Standard envelope: {error: {code, message}}. Some chat endpoints omit
    // `message`; fall back to a status-based line.
    final err = json?["error"];
    String? code;
    String? message;
    if (err is Map) {
      code = err["code"] as String?;
      message = err["message"] as String?;
    }
    if (code == null && message == null) {
      try {
        final decoded = jsonDecode(res.body);
        if (decoded is Map && decoded["message"] is String) {
          message = decoded["message"] as String;
        }
      } catch (_) {}
    }
    final text = message ??
        (res.statusCode == 401
            ? "Your session expired. Sign in again."
            : "Request failed (${res.statusCode}).");
    if (res.statusCode == 401) {
      throw ApiException(text, code: code, statusCode: res.statusCode);
    }
    throw ApiException(text, code: code, statusCode: res.statusCode);
  }

  Future<http.Response> _post(String path, Map<String, dynamic> body) async {
    final http.Response res;
    try {
      res = await _http.post(_url(path), headers: _headers(json: true), body: jsonEncode(body));
    } catch (e) {
      throw AuthException("Can't reach ${_auth.baseUrl}. Check the address and your connection.");
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return res;
    throw AuthException(_errorMessage(res));
  }

  String _errorMessage(http.Response res) {
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map) {
        final msg = decoded["message"] ?? (decoded["error"] is Map ? decoded["error"]["message"] : decoded["error"]);
        if (msg is String && msg.isNotEmpty) return msg;
      }
    } catch (_) {}
    if (res.statusCode == 401) return "Invalid email or password.";
    return "Request failed (${res.statusCode}).";
  }

  String? _tokenFromBody(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map && decoded["token"] is String) return decoded["token"] as String;
    } catch (_) {}
    return null;
  }

  PlexoUser? _userFromBody(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map) {
        final u = decoded["user"] ?? decoded;
        if (u is Map && u["id"] != null && u["email"] != null) {
          return PlexoUser.fromJson(Map<String, dynamic>.from(u));
        }
      }
    } catch (_) {}
    return null;
  }

  void dispose() => _http.close();
}
