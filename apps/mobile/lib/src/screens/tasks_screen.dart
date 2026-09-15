// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Tasks — the workspace's task queue from GET /api/v1/tasks, with a status
// filter and pull-to-refresh. Tapping a row opens the task detail page (steps +
// outcome); terminal tasks can be retried and active ones cancelled.

import "package:flutter/material.dart";

import "../api/models.dart";
import "../api/plexo_client.dart";
import "../theme/tokens.dart";
import "task_detail_screen.dart";

class TasksScreen extends StatefulWidget {
  const TasksScreen({
    super.key,
    required this.client,
    required this.workspaceId,
    this.initialTaskId,
  });

  final PlexoClient client;
  final String workspaceId;

  /// When set, the detail page opens immediately (deep link from chat).
  final String? initialTaskId;

  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends State<TasksScreen> {
  static const _filters = <String, String?>{
    "Active": "queued,claimed,running,awaiting_approval",
    "All": null,
    "Done": "complete",
    "Failed": "failed,blocked,cancelled",
  };

  String _filter = "Active";
  late Future<List<Task>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
    final taskId = widget.initialTaskId;
    if (taskId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _openTask(taskId));
    }
  }

  Future<List<Task>> _load() => widget.client.listTasks(widget.workspaceId, status: _filters[_filter]);

  Future<void> _refresh() async {
    final next = _load();
    setState(() => _future = next);
    await next;
  }

  void _openTask(String taskId) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => TaskDetailScreen(client: widget.client, taskId: taskId),
    )).then((_) => _refresh());
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        SizedBox(
          height: 48,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: PlexoSpace.s3, vertical: PlexoSpace.s2),
            children: [
              for (final label in _filters.keys)
                Padding(
                  padding: const EdgeInsets.only(right: PlexoSpace.s2),
                  child: ChoiceChip(
                    label: Text(label),
                    selected: _filter == label,
                    onSelected: (_) {
                      setState(() {
                        _filter = label;
                        _future = _load();
                      });
                    },
                  ),
                ),
            ],
          ),
        ),
        Divider(height: 1, color: scheme.outlineVariant),
        Expanded(
          child: FutureBuilder<List<Task>>(
            future: _future,
            builder: (context, snap) {
              if (snap.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snap.hasError) {
                return _ErrorState(message: _msg(snap.error), onRetry: _refresh);
              }
              final tasks = snap.data ?? const [];
              if (tasks.isEmpty) {
                return _EmptyState(
                  icon: Icons.checklist_outlined,
                  title: "No $_filter tasks",
                  subtitle: "Queue work from Chat and it will show up here.",
                );
              }
              return RefreshIndicator(
                onRefresh: _refresh,
                child: ListView.separated(
                  itemCount: tasks.length,
                  separatorBuilder: (_, _) => Divider(height: 1, color: scheme.outlineVariant),
                  itemBuilder: (context, i) {
                    final t = tasks[i];
                    return ListTile(
                      title: Text(
                        t.description?.isNotEmpty == true ? t.description! : t.type,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Padding(
                        padding: const EdgeInsets.only(top: PlexoSpace.s1),
                        child: Row(
                          children: [
                            TaskStatusChip(status: t.status),
                            const SizedBox(width: PlexoSpace.s2),
                            Flexible(
                              child: Text(
                                _relative(t.createdAt),
                                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                                      color: scheme.onSurfaceVariant,
                                    ),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => _openTask(t.id),
                    );
                  },
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  static String _msg(Object? error) =>
      error is ApiException ? error.message : "Couldn't load tasks.";
}

class TaskStatusChip extends StatelessWidget {
  const TaskStatusChip({super.key, required this.status});
  final String status;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (status) {
      "complete" => ("Complete", PlexoColor.signalGreen),
      "failed" => ("Failed", PlexoColor.signalRed),
      "blocked" => ("Blocked", PlexoColor.amber),
      "cancelled" => ("Cancelled", PlexoColor.textMuted),
      "awaiting_approval" => ("Awaiting approval", PlexoColor.amber),
      "running" => ("Running", PlexoColor.accent),
      "claimed" => ("Starting", PlexoColor.accent),
      _ => ("Queued", PlexoColor.textSecondary),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: PlexoSpace.s2, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(PlexoRadius.sm),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color, fontWeight: FontWeight.w500),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.icon, required this.title, required this.subtitle});
  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(PlexoSpace.s8),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, size: 40, color: scheme.onSurfaceVariant),
            const SizedBox(height: PlexoSpace.s3),
            Text(title, style: text.titleMedium),
            const SizedBox(height: PlexoSpace.s1),
            Text(subtitle, style: text.bodySmall?.copyWith(color: scheme.onSurfaceVariant), textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});
  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return _EmptyState(icon: Icons.cloud_off, title: "Couldn't load", subtitle: message);
  }
}

String _relative(DateTime? when) {
  if (when == null) return "";
  final diff = DateTime.now().difference(when);
  if (diff.inMinutes < 1) return "just now";
  if (diff.inMinutes < 60) return "${diff.inMinutes}m ago";
  if (diff.inHours < 24) return "${diff.inHours}h ago";
  return "${diff.inDays}d ago";
}
