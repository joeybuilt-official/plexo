// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Authenticated shell. Owns the selected workspace (every surface is scoped to
// one) and the bottom-nav destinations: Chat, Threads, Tasks, Settings.
//
// Agents is intentionally absent: the API exposes no list-agents route for
// sessions (only POST /agents/run for service-key callers), so a tab there
// would be an empty screen — exactly the "no real functionality" the app is
// shedding. Add it when a session-scoped agents list exists.

import "package:flutter/material.dart";

import "../api/models.dart";
import "../api/plexo_client.dart";
import "../state/workspace_store.dart";
import "../theme/tokens.dart";
import "../widgets/plexo_mark.dart";
import "chat_screen.dart";
import "settings_screen.dart";
import "tasks_screen.dart";
import "threads_screen.dart";

class MainShell extends StatefulWidget {
  const MainShell({
    super.key,
    required this.client,
    required this.user,
    required this.workspaces,
    required this.onSignOut,
  });

  final PlexoClient client;
  final PlexoUser user;
  final WorkspaceStore workspaces;
  final VoidCallback onSignOut;

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _index = 0;

  /// A task opened from Chat/Threads deep-links into the Tasks tab.
  String? _pendingTaskId;

  Future<void> _selectWorkspace(String workspaceId) async {
    await widget.workspaces.select(workspaceId);
    if (mounted) setState(() {});
  }

  void _openTask(String taskId) {
    setState(() {
      _pendingTaskId = taskId;
      _index = 2; // Tasks
    });
  }

  @override
  Widget build(BuildContext context) {
    final selected = widget.workspaces.selected;
    if (selected == null) {
      return Scaffold(
        appBar: AppBar(title: const Text("Plexo"), actions: [
          IconButton(onPressed: widget.onSignOut, icon: const Icon(Icons.logout), tooltip: "Sign out"),
        ]),
        body: const Center(
          child: Padding(
            padding: EdgeInsets.all(32),
            child: Text(
              "No workspace available for this account.",
              textAlign: TextAlign.center,
            ),
          ),
        ),
      );
    }

    final titles = ["Chat", "Threads", "Tasks", "Settings"];
    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const PlexoMark(size: 22, color: PlexoColor.textPrimary),
            const SizedBox(width: 10),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(titles[_index], style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  Text(
                    selected.name,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      body: switch (_index) {
        0 => ChatScreen(
            key: ValueKey("chat-${selected.id}"),
            client: widget.client,
            workspaceId: selected.id,
            workspaceName: selected.name,
            onOpenTask: _openTask,
          ),
        1 => ThreadsScreen(
            key: ValueKey("threads-${selected.id}"),
            client: widget.client,
            workspaceId: selected.id,
          ),
        2 => TasksScreen(
            key: ValueKey("tasks-${selected.id}-${_pendingTaskId ?? ''}"),
            client: widget.client,
            workspaceId: selected.id,
            initialTaskId: _pendingTaskId,
          ),
        _ => SettingsScreen(
            user: widget.user,
            workspaces: widget.workspaces,
            baseUrl: widget.client.baseUrl,
            onSelectWorkspace: _selectWorkspace,
            onSignOut: widget.onSignOut,
          ),
      },
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() {
          _index = i;
          if (i != 2) _pendingTaskId = null;
        }),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), selectedIcon: Icon(Icons.chat_bubble), label: "Chat"),
          NavigationDestination(icon: Icon(Icons.forum_outlined), selectedIcon: Icon(Icons.forum), label: "Threads"),
          NavigationDestination(icon: Icon(Icons.checklist_outlined), selectedIcon: Icon(Icons.checklist), label: "Tasks"),
          NavigationDestination(icon: Icon(Icons.settings_outlined), selectedIcon: Icon(Icons.settings), label: "Settings"),
        ],
      ),
    );
  }
}
