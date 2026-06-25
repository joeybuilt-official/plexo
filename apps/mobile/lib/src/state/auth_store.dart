// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Session + base URL persistence. Hardware-backed via flutter_secure_storage
// (Android Keystore). Plexo auth is better-auth; Phase 1 (Conflict 1 →
// bearer token endpoint) decides exactly what token is stored here. For the
// Phase 0 shell this just holds the base URL + an opaque bearer slot so the
// shell can route to login vs. main without an auth backend yet.
//
// Load is async (each read decrypts); values are cached on the instance after
// load so screen builds stay synchronous.

import "package:flutter_secure_storage/flutter_secure_storage.dart";

class AuthStore {
  AuthStore._(this._storage, this._token, this._baseUrl);

  static const _kToken = "plexo.token";
  static const _kBaseUrl = "plexo.baseUrl";
  static const defaultBaseUrl = "https://getplexo.com";

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
    return AuthStore._(storage, token, baseUrl ?? defaultBaseUrl);
  }

  String? get token => _token;
  String get baseUrl => _baseUrl;
  bool get isAuthenticated => (_token ?? "").isNotEmpty;

  Future<void> save({required String token, required String baseUrl}) async {
    await _storage.write(key: _kToken, value: token);
    await _storage.write(key: _kBaseUrl, value: baseUrl);
    _token = token;
    _baseUrl = baseUrl;
  }

  Future<void> clear() async {
    await _storage.delete(key: _kToken);
    _token = null;
  }
}
