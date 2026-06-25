// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 1 smoke test. Auth screens depend on PlexoClient/AuthStore, which use
// secure-storage + network platform channels not available under flutter_test,
// so unit coverage here stays on the pure design-system. End-to-end auth is
// verified against a live instance (see the phased plan's Phase 1 verify step).

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:plexo_mobile/src/theme/app_theme.dart";
import "package:plexo_mobile/src/theme/tokens.dart";

void main() {
  test("dark theme uses the web-ported accent + dark surfaces", () {
    final theme = PlexoTheme.dark();
    expect(theme.brightness, Brightness.dark);
    expect(theme.colorScheme.primary, PlexoColor.accent);
    expect(theme.colorScheme.surface, PlexoColor.canvas);
  });

  testWidgets("themed scaffold renders", (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: PlexoTheme.dark(),
        home: const Scaffold(body: Center(child: Text("Plexo"))),
      ),
    );
    expect(find.text("Plexo"), findsOneWidget);
  });
}
