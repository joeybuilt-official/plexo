// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Settings — account info, workspace switching (the API scopes every surface
// to a workspaceId), the instance URL in use, and sign-out.

import "package:flutter/material.dart";

import "../api/models.dart";
import "../state/workspace_store.dart";
import "../theme/tokens.dart";

class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.user,
    required this.workspaces,
    required this.baseUrl,
    required this.onSelectWorkspace,
    required this.onSignOut,
  });

  final PlexoUser user;
  final WorkspaceStore workspaces;
  final String baseUrl;
  final Future<void> Function(String workspaceId) onSelectWorkspace;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final selected = workspaces.selected;
    return ListView(
      padding: const EdgeInsets.all(PlexoSpace.s4),
      children: [
        Card(
          child: ListTile(
            leading: CircleAvatar(
              backgroundColor: scheme.primaryContainer,
              foregroundColor: scheme.onPrimaryContainer,
              child: Text(
                (user.name?.isNotEmpty == true ? user.name! : user.email).characters.first.toUpperCase(),
              ),
            ),
            title: Text(user.name?.isNotEmpty == true ? user.name! : user.email),
            subtitle: Text(user.email, style: text.bodySmall),
          ),
        ),
        const SizedBox(height: PlexoSpace.s4),

        Text(
          "WORKSPACE",
          style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant, letterSpacing: 0.8),
        ),
        const SizedBox(height: PlexoSpace.s2),
        if (workspaces.workspaces.isEmpty)
          Text("No workspaces available.", style: text.bodySmall?.copyWith(color: scheme.onSurfaceVariant))
        else
          Card(
            child: RadioGroup<String>(
              groupValue: selected?.id,
              onChanged: (id) {
                if (id != null) onSelectWorkspace(id);
              },
              child: Column(
                children: [
                  for (final w in workspaces.workspaces)
                    RadioListTile<String>(
                      value: w.id,
                      title: Text(w.name),
                      dense: true,
                    ),
                ],
              ),
            ),
          ),
        const SizedBox(height: PlexoSpace.s4),

        Text(
          "INSTANCE",
          style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant, letterSpacing: 0.8),
        ),
        const SizedBox(height: PlexoSpace.s2),
        Card(
          child: ListTile(
            leading: const Icon(Icons.dns_outlined),
            title: const Text("Server"),
            subtitle: Text(baseUrl, style: text.bodySmall),
          ),
        ),
        const SizedBox(height: PlexoSpace.s6),

        OutlinedButton.icon(
          onPressed: onSignOut,
          icon: const Icon(Icons.logout),
          label: const Text("Sign out"),
        ),
        const SizedBox(height: PlexoSpace.s4),
        Text(
          "Plexo mobile",
          style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}
