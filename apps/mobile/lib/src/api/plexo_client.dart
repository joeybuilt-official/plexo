// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo HTTP gateway (adapter). Hand-written http client against the Plexo
// API (apps/api). It owns base-URL + bearer-header injection so screens never
// touch transport concerns. Phase 1 fleshes out the typed endpoints (generated
// from apps/api/openapi.yaml + hand-tuned). Phase 0 ships only the shell of the
// client so the composition root has something to wire.

import "package:http/http.dart" as http;

import "../state/auth_store.dart";

class PlexoClient {
  PlexoClient(this._auth, {http.Client? client})
      : _http = client ?? http.Client();

  final AuthStore _auth;
  final http.Client _http;

  Uri _url(String path) => Uri.parse("${_auth.baseUrl}$path");

  Map<String, String> get _headers => {
        "Accept": "application/json",
        if (_auth.token != null) "Authorization": "Bearer ${_auth.token}",
      };

  /// Liveness probe — used by the Phase 0 shell to prove the transport layer
  /// is wired. Returns true on any 2xx.
  Future<bool> ping() async {
    try {
      final res = await _http.get(_url("/api/health"), headers: _headers);
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  void dispose() => _http.close();
}
