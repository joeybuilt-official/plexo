// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Real sign-in / sign-up against a Plexo instance (better-auth bearer flow,
// ADR-0001 Phase 1). On success the token is persisted by PlexoClient and the
// authenticated user is handed back via onAuthenticated.

import "package:flutter/material.dart";

import "../api/models.dart";
import "../api/plexo_client.dart";
import "../theme/tokens.dart";
import "../widgets/plexo_mark.dart";

enum _Mode { signIn, signUp }

class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.client,
    required this.initialBaseUrl,
    required this.onAuthenticated,
  });

  final PlexoClient client;
  final String initialBaseUrl;
  final void Function(PlexoUser user) onAuthenticated;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _instance = TextEditingController(text: widget.initialBaseUrl);
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();

  _Mode _mode = _Mode.signIn;
  bool _busy = false;
  String? _error;
  String? _notice;

  @override
  void dispose() {
    _instance.dispose();
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _error = null;
      _notice = null;
    });
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final user = _mode == _Mode.signIn
          ? await widget.client.signIn(
              baseUrl: _instance.text,
              email: _email.text.trim(),
              password: _password.text,
            )
          : await widget.client.signUp(
              baseUrl: _instance.text,
              name: _name.text.trim(),
              email: _email.text.trim(),
              password: _password.text,
            );
      if (mounted) widget.onAuthenticated(user);
    } on AuthException catch (e) {
      // sign-up on a verification-gated instance throws a friendly notice.
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _forgot() async {
    if (_email.text.trim().isEmpty) {
      setState(() => _error = "Enter your email first, then tap Forgot password.");
      return;
    }
    setState(() => _busy = true);
    await widget.client.requestPasswordReset(baseUrl: _instance.text, email: _email.text.trim());
    if (mounted) {
      setState(() {
        _busy = false;
        _error = null;
        _notice = "If that email has an account, a reset link is on its way.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final signingIn = _mode == _Mode.signIn;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(PlexoSpace.s6),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 380),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Center(child: PlexoMark(size: 44, color: PlexoColor.textPrimary)),
                    const SizedBox(height: PlexoSpace.s3),
                    Text("Plexo", style: text.headlineMedium, textAlign: TextAlign.center),
                    const SizedBox(height: PlexoSpace.s1),
                    Text(
                      signingIn ? "Sign in to your instance" : "Create your account",
                      style: text.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: PlexoSpace.s6),
                    TextFormField(
                      controller: _instance,
                      decoration: const InputDecoration(labelText: "Instance URL"),
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      validator: (v) => (v == null || v.trim().isEmpty) ? "Required" : null,
                    ),
                    if (!signingIn) ...[
                      const SizedBox(height: PlexoSpace.s3),
                      TextFormField(
                        controller: _name,
                        decoration: const InputDecoration(labelText: "Name"),
                        textCapitalization: TextCapitalization.words,
                        validator: (v) =>
                            (!signingIn && (v == null || v.trim().isEmpty)) ? "Required" : null,
                      ),
                    ],
                    const SizedBox(height: PlexoSpace.s3),
                    TextFormField(
                      controller: _email,
                      decoration: const InputDecoration(labelText: "Email"),
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      validator: (v) =>
                          (v == null || !v.contains("@")) ? "Enter a valid email" : null,
                    ),
                    const SizedBox(height: PlexoSpace.s3),
                    TextFormField(
                      controller: _password,
                      decoration: const InputDecoration(labelText: "Password"),
                      obscureText: true,
                      validator: (v) => (v == null || v.length < 12)
                          ? "At least 12 characters"
                          : null,
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: PlexoSpace.s3),
                      Text(_error!, style: text.bodySmall?.copyWith(color: scheme.error)),
                    ],
                    if (_notice != null) ...[
                      const SizedBox(height: PlexoSpace.s3),
                      Text(_notice!,
                          style: text.bodySmall?.copyWith(color: scheme.tertiary)),
                    ],
                    const SizedBox(height: PlexoSpace.s5),
                    FilledButton(
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(
                              height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : Text(signingIn ? "Sign in" : "Create account"),
                    ),
                    if (signingIn)
                      TextButton(
                        onPressed: _busy ? null : _forgot,
                        child: const Text("Forgot password?"),
                      ),
                    const SizedBox(height: PlexoSpace.s2),
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => setState(() {
                                _mode = signingIn ? _Mode.signUp : _Mode.signIn;
                                _error = null;
                                _notice = null;
                              }),
                      child: Text(signingIn
                          ? "Need an account? Create one"
                          : "Have an account? Sign in"),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
