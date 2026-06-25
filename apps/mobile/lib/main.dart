// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Composition root. Loads the AuthStore (decrypting persisted session), then
// renders the themed app, routing to MainShell when authenticated or the login
// placeholder otherwise. Mirrors fonto_mobile's bootstrap (no Riverpod; manual
// stores threaded down from here).

import "package:flutter/material.dart";

import "src/api/plexo_client.dart";
import "src/screens/login_screen.dart";
import "src/screens/main_shell.dart";
import "src/state/auth_store.dart";
import "src/theme/app_theme.dart";

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final auth = await AuthStore.load();
  runApp(PlexoApp(auth: auth));
}

class PlexoApp extends StatefulWidget {
  const PlexoApp({super.key, required this.auth});

  final AuthStore auth;

  @override
  State<PlexoApp> createState() => _PlexoAppState();
}

class _PlexoAppState extends State<PlexoApp> {
  late final PlexoClient _client = PlexoClient(widget.auth);
  // Phase 0: a local flag stands in for a real session. Phase 1 replaces this
  // with AuthStore.isAuthenticated driven by the bearer flow.
  bool _entered = false;

  @override
  void dispose() {
    _client.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "Plexo",
      debugShowCheckedModeBanner: false,
      theme: PlexoTheme.light(),
      darkTheme: PlexoTheme.dark(),
      themeMode: ThemeMode.dark, // web defaults to dark-zinc
      home: _entered || widget.auth.isAuthenticated
          ? MainShell(onSignOut: () => setState(() => _entered = false))
          : LoginScreen(onContinue: () => setState(() => _entered = true)),
    );
  }
}
