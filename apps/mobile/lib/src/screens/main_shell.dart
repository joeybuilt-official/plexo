// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 0 authenticated shell. Bottom-nav skeleton over the Plexo core
// surfaces; each destination is a placeholder until its phase fills it in
// (Chat/Conversations → Phase 2; Agents/Tasks → Phase 3; Settings → Phase 4).
// Nav structure here just proves the themed shell + navigation render.

import "package:flutter/material.dart";

import "../api/models.dart";
import "../theme/tokens.dart";

class MainShell extends StatefulWidget {
  const MainShell({super.key, required this.user, required this.onSignOut});

  final PlexoUser user;
  final VoidCallback onSignOut;

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _index = 0;

  static const _destinations = <_Dest>[
    _Dest("Chat", Icons.chat_bubble_outline, Icons.chat_bubble),
    _Dest("Threads", Icons.forum_outlined, Icons.forum),
    _Dest("Agents", Icons.smart_toy_outlined, Icons.smart_toy),
    _Dest("Tasks", Icons.checklist_outlined, Icons.checklist),
    _Dest("Settings", Icons.settings_outlined, Icons.settings),
  ];

  @override
  Widget build(BuildContext context) {
    final dest = _destinations[_index];
    return Scaffold(
      appBar: AppBar(
        title: Text(dest.label),
        actions: [
          if (_index == _destinations.length - 1)
            IconButton(
              onPressed: widget.onSignOut,
              icon: const Icon(Icons.logout),
              tooltip: "Sign out",
            ),
        ],
      ),
      body: _index == _destinations.length - 1
          ? _SettingsBody(user: widget.user, onSignOut: widget.onSignOut)
          : _Placeholder(dest: dest),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
          for (final d in _destinations)
            NavigationDestination(
              icon: Icon(d.icon),
              selectedIcon: Icon(d.selectedIcon),
              label: d.label,
            ),
        ],
      ),
    );
  }
}

class _Dest {
  const _Dest(this.label, this.icon, this.selectedIcon);
  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

class _SettingsBody extends StatelessWidget {
  const _SettingsBody({required this.user, required this.onSignOut});
  final PlexoUser user;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return ListView(
      padding: const EdgeInsets.all(PlexoSpace.s4),
      children: [
        Card(
          child: ListTile(
            leading: CircleAvatar(
              backgroundColor: scheme.primaryContainer,
              foregroundColor: scheme.onPrimaryContainer,
              child: Text(
                (user.name?.isNotEmpty == true ? user.name! : user.email)
                    .characters
                    .first
                    .toUpperCase(),
              ),
            ),
            title: Text(user.name?.isNotEmpty == true ? user.name! : user.email),
            subtitle: Text(user.email, style: text.bodySmall),
          ),
        ),
        const SizedBox(height: PlexoSpace.s4),
        OutlinedButton.icon(
          onPressed: onSignOut,
          icon: const Icon(Icons.logout),
          label: const Text("Sign out"),
        ),
        const SizedBox(height: PlexoSpace.s4),
        Text(
          "Full settings arrive in a later phase.",
          style: text.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }
}

class _Placeholder extends StatelessWidget {
  const _Placeholder({required this.dest});
  final _Dest dest;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(dest.selectedIcon, size: 40, color: scheme.onSurfaceVariant),
          const SizedBox(height: PlexoSpace.s3),
          Text(dest.label, style: text.titleMedium),
          const SizedBox(height: PlexoSpace.s1),
          Text(
            "Coming in a later phase",
            style: text.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
