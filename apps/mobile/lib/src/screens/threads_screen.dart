// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Threads — the workspace's conversation history from
// GET /api/v1/conversations (newest first). Tapping a turn that produced a task
// opens that task; otherwise the turn's full reply is shown inline.

import "package:flutter/material.dart";

import "../api/models.dart";
import "../api/plexo_client.dart";
import "../theme/tokens.dart";
import "task_detail_screen.dart";

class ThreadsScreen extends StatefulWidget {
  const ThreadsScreen({super.key, required this.client, required this.workspaceId});

  final PlexoClient client;
  final String workspaceId;

  @override
  State<ThreadsScreen> createState() => _ThreadsScreenState();
}

class _ThreadsScreenState extends State<ThreadsScreen> {
  late Future<List<Conversation>> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.client.listConversations(widget.workspaceId);
  }

  Future<void> _refresh() async {
    final next = widget.client.listConversations(widget.workspaceId);
    setState(() => _future = next);
    await next;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FutureBuilder<List<Conversation>>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          final msg = snap.error is ApiException ? (snap.error as ApiException).message : "Couldn't load threads.";
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(PlexoSpace.s8),
              child: Text(msg, textAlign: TextAlign.center),
            ),
          );
        }
        final turns = snap.data ?? const [];
        if (turns.isEmpty) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(PlexoSpace.s8),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.forum_outlined, size: 40, color: scheme.onSurfaceVariant),
                  const SizedBox(height: PlexoSpace.s3),
                  Text("No conversations yet", style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: PlexoSpace.s1),
                  Text(
                    "Your chat history appears here.",
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          );
        }
        return RefreshIndicator(
          onRefresh: _refresh,
          child: ListView.separated(
            itemCount: turns.length,
            separatorBuilder: (_, _) => Divider(height: 1, color: scheme.outlineVariant),
            itemBuilder: (context, i) {
              final c = turns[i];
              final preview = c.reply?.isNotEmpty == true ? c.reply! : (c.errorMsg ?? "");
              return ListTile(
                leading: Icon(
                  c.taskId != null ? Icons.checklist : Icons.chat_bubble_outline,
                  color: scheme.onSurfaceVariant,
                ),
                title: Text(c.message, maxLines: 2, overflow: TextOverflow.ellipsis),
                subtitle: preview.isEmpty
                    ? null
                    : Padding(
                        padding: const EdgeInsets.only(top: PlexoSpace.s1),
                        child: Text(preview, maxLines: 2, overflow: TextOverflow.ellipsis),
                      ),
                trailing: c.taskId != null ? const Icon(Icons.chevron_right) : null,
                onTap: c.taskId == null
                    ? null
                    : () => Navigator.of(context).push(MaterialPageRoute(
                          builder: (_) => TaskDetailScreen(client: widget.client, taskId: c.taskId!),
                        )).then((_) => _refresh()),
              );
            },
          ),
        );
      },
    );
  }
}
