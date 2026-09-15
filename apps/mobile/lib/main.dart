// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Composition root. Loads the AuthStore (decrypting any persisted token), then
// renders the themed app. On launch it validates the token against the instance
// (getSession); a valid session loads the workspace list and goes straight to
// MainShell, otherwise to the login screen. Mirrors fonto_mobile's bootstrap
// (no Riverpod; manual stores threaded down from here).

import "package:flutter/material.dart";

import "src/api/models.dart";
import "src/api/plexo_client.dart";
import "src/screens/login_screen.dart";
import "src/screens/main_shell.dart";
import "src/state/auth_store.dart";
import "src/state/workspace_store.dart";
import "src/theme/app_theme.dart";

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final auth = await AuthStore.load();
  final workspaces = await WorkspaceStore.load();
  runApp(PlexoApp(auth: auth, workspaces: workspaces));
}

class PlexoApp extends StatefulWidget {
  const PlexoApp({super.key, required this.auth, required this.workspaces});

  final AuthStore auth;
  final WorkspaceStore workspaces;

  @override
  State<PlexoApp> createState() => _PlexoAppState();
}

class _PlexoAppState extends State<PlexoApp> {
  late final PlexoClient _client = PlexoClient(widget.auth);
  PlexoUser? _user;
  bool _booting = true;

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    final user = await _client.getSession();
    if (user != null) {
      await _loadWorkspaces();
    }
    if (mounted) {
      setState(() {
        _user = user;
        _booting = false;
      });
    }
  }

  /// The workspace list backs every authenticated surface; a failure here is
  /// non-fatal (MainShell renders an empty-workspace state).
  Future<void> _loadWorkspaces() async {
    try {
      final list = await _client.listWorkspaces();
      await widget.workspaces.setWorkspaces(list);
    } on ApiException {
      // Leave the persisted list (if any) in place; the shell shows its empty
      // state when there is none.
    }
  }

  @override
  void dispose() {
    _client.dispose();
    super.dispose();
  }

  Future<void> _signOut() async {
    await _client.signOut();
    await widget.workspaces.setWorkspaces(const []);
    if (mounted) setState(() => _user = null);
  }

  Future<void> _onAuthenticated(PlexoUser user) async {
    await _loadWorkspaces();
    if (mounted) setState(() => _user = user);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "Plexo",
      debugShowCheckedModeBanner: false,
      theme: PlexoTheme.light(),
      darkTheme: PlexoTheme.dark(),
      themeMode: ThemeMode.dark, // web defaults to dark-zinc
      home: _booting
          ? const _Splash()
          : _user != null
              ? MainShell(
                  client: _client,
                  user: _user!,
                  workspaces: widget.workspaces,
                  onSignOut: _signOut,
                )
              : LoginScreen(
                  client: _client,
                  initialBaseUrl: widget.auth.baseUrl,
                  onAuthenticated: _onAuthenticated,
                ),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();
  @override
  Widget build(BuildContext context) =>
      const Scaffold(body: Center(child: CircularProgressIndicator()));
}
