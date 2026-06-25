// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 0 login placeholder. Real auth (better-auth bearer flow, Conflict 1)
// lands in Phase 1; this screen only proves the themed shell renders and routes
// into MainShell. Do not wire real credentials here yet.

import "package:flutter/material.dart";

import "../theme/tokens.dart";

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key, required this.onContinue});

  /// Invoked when the user proceeds. Phase 1 replaces this with an authenticated
  /// session; Phase 0 just transitions to the shell.
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 360),
          child: Padding(
            padding: const EdgeInsets.all(PlexoSpace.s6),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(Icons.hub_outlined, size: 48, color: scheme.primary),
                const SizedBox(height: PlexoSpace.s4),
                Text("Plexo", style: text.headlineMedium, textAlign: TextAlign.center),
                const SizedBox(height: PlexoSpace.s2),
                Text(
                  "Native client — Phase 0 shell",
                  style: text.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: PlexoSpace.s8),
                FilledButton(
                  onPressed: onContinue,
                  child: const Text("Continue"),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
