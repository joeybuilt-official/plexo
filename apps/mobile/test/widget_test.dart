// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 0 smoke test. Pumps the themed login placeholder directly (AuthStore
// uses secure-storage platform channels not available under flutter_test, so
// the composition root is exercised in widget/integration tests later phases).

import "package:flutter/material.dart";
import "package:flutter_test/flutter_test.dart";
import "package:plexo_mobile/src/screens/login_screen.dart";
import "package:plexo_mobile/src/theme/app_theme.dart";

void main() {
  testWidgets("login placeholder renders and Continue fires", (tester) async {
    var continued = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: PlexoTheme.dark(),
        home: LoginScreen(onContinue: () => continued = true),
      ),
    );

    expect(find.text("Plexo"), findsOneWidget);
    expect(find.text("Continue"), findsOneWidget);

    await tester.tap(find.text("Continue"));
    expect(continued, isTrue);
  });
}
