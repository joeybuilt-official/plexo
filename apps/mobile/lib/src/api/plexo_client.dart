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
// better-auth handler, /api/v1/* is the proxied Plexo API.

import "dart:convert";

import "package:http/http.dart" as http;

import "../state/auth_store.dart";
import "models.dart";

class PlexoClient {
  PlexoClient(this._auth, {http.Client? client}) : _http = client ?? http.Client();

  final AuthStore _auth;
  final http.Client _http;

  Uri _url(String path) => Uri.parse("${_auth.baseUrl}$path");

  Map<String, String> _headers({bool json = false}) => {
        "Accept": "application/json",
        if (json) "Content-Type": "application/json",
        if (_auth.token != null) "Authorization": "Bearer ${_auth.token}",
      };

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
