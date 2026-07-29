// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Session + base URL persistence. Hardware-backed via flutter_secure_storage
// (Android Keystore). The token is a better-auth session token obtained through
// the bearer plugin (ADR-0001 Phase 1) — as sensitive as a cookie, so it lives
// in encrypted storage, never shared_preferences.
//
// Load is async (each read decrypts); values are cached on the instance after
// load so screen builds stay synchronous.

import "package:flutter_secure_storage/flutter_secure_storage.dart";

class AuthStore {
  AuthStore._(this._storage, this._token, this._baseUrl);

  static const _kToken = "plexo.token";
  static const _kBaseUrl = "plexo.baseUrl";
  // The app (better-auth at /api/auth/*, plus the /api/v1 proxy) is served by
  // plexo-saas at app.getplexo.com. getplexo.com is the marketing site.
  static const defaultBaseUrl = "https://app.getplexo.com";

  static const _androidOpts = AndroidOptions(encryptedSharedPreferences: true);
  static const _iosOpts = IOSOptions(
    accessibility: KeychainAccessibility.first_unlock,
  );

  final FlutterSecureStorage _storage;
  String? _token;
  String _baseUrl;

  static Future<AuthStore> load() async {
    const storage = FlutterSecureStorage(
      aOptions: _androidOpts,
      iOptions: _iosOpts,
    );
    final token = await storage.read(key: _kToken);
    final baseUrl = await storage.read(key: _kBaseUrl);
    return AuthStore._(storage, token, _normalize(baseUrl) ?? defaultBaseUrl);
  }

  String? get token => _token;
  String get baseUrl => _baseUrl;
  bool get isAuthenticated => (_token ?? "").isNotEmpty;

  Future<void> setBaseUrl(String baseUrl) async {
    _baseUrl = _normalize(baseUrl) ?? defaultBaseUrl;
    await _storage.write(key: _kBaseUrl, value: _baseUrl);
  }

  Future<void> setToken(String token) async {
    _token = token;
    await _storage.write(key: _kToken, value: token);
  }

  Future<void> clear() async {
    await _storage.delete(key: _kToken);
    _token = null;
  }

  /// Trim trailing slash + default the scheme to https so "getplexo.com" and
  /// "https://getplexo.com/" both resolve the same way.
  static String? _normalize(String? raw) {
    if (raw == null) return null;
    var v = raw.trim();
    if (v.isEmpty) return null;
    if (!v.startsWith("http://") && !v.startsWith("https://")) v = "https://$v";
    while (v.endsWith("/")) {
      v = v.substring(0, v.length - 1);
    }
    return v;
  }
}
