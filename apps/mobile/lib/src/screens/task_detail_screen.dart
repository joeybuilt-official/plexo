// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Task detail — GET /api/v1/tasks/:id. Shows the request, an outcome/failure
// summary, the step trail, and cost/quality metadata. Active tasks can be
// cancelled; failed/cancelled ones retried.

import "package:flutter/material.dart";

import "../api/models.dart";
import "../api/plexo_client.dart";
import "../theme/tokens.dart";
import "tasks_screen.dart" show TaskStatusChip;

class TaskDetailScreen extends StatefulWidget {
  const TaskDetailScreen({super.key, required this.client, required this.taskId});

  final PlexoClient client;
  final String taskId;

  @override
  State<TaskDetailScreen> createState() => _TaskDetailScreenState();
}

class _TaskDetailScreenState extends State<TaskDetailScreen> {
  late Future<TaskDetail> _future;
  bool _acting = false;

  @override
  void initState() {
    super.initState();
    _future = widget.client.getTask(widget.taskId);
  }

  Future<void> _reload() async {
    final next = widget.client.getTask(widget.taskId);
    setState(() => _future = next);
    await next;
  }

  Future<void> _act(Future<void> Function() op) async {
    setState(() => _acting = true);
    try {
      await op();
      await _reload();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Task"),
        actions: [
          IconButton(onPressed: _acting ? null : _reload, icon: const Icon(Icons.refresh), tooltip: "Refresh"),
        ],
      ),
      body: FutureBuilder<TaskDetail>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            final msg = snap.error is ApiException
                ? (snap.error as ApiException).message
                : "Couldn't load this task.";
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(PlexoSpace.s8),
                child: Text(msg, textAlign: TextAlign.center),
              ),
            );
          }
          final detail = snap.data!;
          return RefreshIndicator(
            onRefresh: _reload,
            child: ListView(
              padding: const EdgeInsets.all(PlexoSpace.s4),
              children: _body(context, detail),
            ),
          );
        },
      ),
    );
  }

  List<Widget> _body(BuildContext context, TaskDetail detail) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final task = detail.task;
    return [
      Row(
        children: [
          TaskStatusChip(status: task.status),
          const SizedBox(width: PlexoSpace.s2),
          Text(task.type, style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
        ],
      ),
      const SizedBox(height: PlexoSpace.s3),
      Text(
        task.description?.isNotEmpty == true ? task.description! : "(no request text)",
        style: text.bodyLarge,
      ),
      const SizedBox(height: PlexoSpace.s4),

      if (task.outcomeSummary?.isNotEmpty == true) ...[
        _SectionTitle("Outcome"),
        _Panel(child: SelectableText(task.outcomeSummary!, style: text.bodyMedium)),
        const SizedBox(height: PlexoSpace.s4),
      ],
      if (task.failureReason?.isNotEmpty == true) ...[
        _SectionTitle("Failure"),
        _Panel(
          borderColor: scheme.error,
          child: SelectableText(task.failureReason!, style: text.bodyMedium),
        ),
        const SizedBox(height: PlexoSpace.s4),
      ],

      if (task.isActive || task.status == "failed" || task.status == "cancelled") ...[
        Row(
          children: [
            if (task.isActive)
              OutlinedButton.icon(
                onPressed: _acting ? null : () => _act(() => widget.client.cancelTask(task.id)),
                icon: const Icon(Icons.stop_circle_outlined, size: 18),
                label: const Text("Cancel"),
              ),
            if (task.isActive) const SizedBox(width: PlexoSpace.s2),
            if (!task.isActive)
              OutlinedButton.icon(
                onPressed: _acting ? null : () => _act(() => widget.client.retryTask(task.id)),
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text("Retry"),
              ),
          ],
        ),
        const SizedBox(height: PlexoSpace.s4),
      ],

      if (detail.steps.isNotEmpty) ...[
        _SectionTitle("Steps (${detail.steps.length})"),
        for (final step in detail.steps) _StepTile(step: step),
        const SizedBox(height: PlexoSpace.s4),
      ],

      _SectionTitle("Details"),
      _Panel(
        child: Column(
          children: [
            _MetaRow(label: "ID", value: task.id),
            if (task.routedProvider != null) _MetaRow(label: "Provider", value: task.routedProvider!),
            if (task.routedModel != null) _MetaRow(label: "Model", value: task.routedModel!),
            if (task.qualityScore != null) _MetaRow(label: "Quality", value: task.qualityScore!.toStringAsFixed(2)),
            if (task.costUsd != null) _MetaRow(label: "Cost", value: "\$${task.costUsd!.toStringAsFixed(4)}"),
          ],
        ),
      ),
    ];
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.label);
  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: PlexoSpace.s2),
      child: Text(
        label.toUpperCase(),
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              letterSpacing: 0.8,
            ),
      ),
    );
  }
}

class _Panel extends StatelessWidget {
  const _Panel({required this.child, this.borderColor});
  final Widget child;
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(PlexoSpace.s3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(PlexoRadius.md),
        border: Border.all(color: borderColor ?? scheme.outlineVariant),
      ),
      child: child,
    );
  }
}

class _StepTile extends StatelessWidget {
  const _StepTile({required this.step});
  final TaskStep step;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final (icon, color) = switch (step.state) {
      "completed" => (Icons.check_circle, PlexoColor.signalGreen),
      "failed" => (Icons.error, PlexoColor.signalRed),
      "running" => (Icons.play_circle, PlexoColor.accent),
      "skipped" => (Icons.remove_circle_outline, PlexoColor.textMuted),
      _ => (Icons.circle_outlined, PlexoColor.textSecondary),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: PlexoSpace.s2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: PlexoSpace.s2),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text("Step ${step.stepNumber} · ${step.stepType ?? step.state}", style: text.bodySmall),
                if (step.outcome?.isNotEmpty == true)
                  Text(
                    step.outcome!,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
                  ),
                if (step.error?.isNotEmpty == true)
                  Text(step.error!, style: text.labelSmall?.copyWith(color: scheme.error)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _MetaRow extends StatelessWidget {
  const _MetaRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 76, child: Text(label, style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant))),
          Expanded(child: SelectableText(value, style: text.labelSmall)),
        ],
      ),
    );
  }
}
