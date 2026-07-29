// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Domain types crossing the API boundary. Kept framework-free (plain Dart) so
// screens and the client share one vocabulary.

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

/// Raised for an expected auth failure (bad creds, expired session, network).
/// The message is safe to show the user.
class AuthException implements Exception {
  const AuthException(this.message);
  final String message;
  @override
  String toString() => message;
}
