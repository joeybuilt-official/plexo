// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Chat — the app's core surface. Sends a turn to POST /api/v1/chat/message and
// renders whichever terminal shape comes back: a direct reply (CONVERSATION),
// a queued task (TASK → poll GET /api/v1/chat/reply/:taskId), a project
// confirmation, or a soft AI error.

import "dart:math";

import "package:flutter/material.dart";

import "../api/models.dart";
import "../api/plexo_client.dart";
import "../theme/tokens.dart";
import "../widgets/plexo_mark.dart";

class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.client,
    required this.workspaceId,
    required this.workspaceName,
    this.onOpenTask,
  });

  final PlexoClient client;
  final String workspaceId;
  final String workspaceName;
  final void Function(String taskId)? onOpenTask;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

enum _Who { user, agent }

class _Turn {
  _Turn({required this.who, required this.text, this.model, this.taskId, this.failed = false});
  final _Who who;
  String text;
  String? model;
  String? taskId;
  bool failed;
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<_Turn> _turns = [];
  final _sessionId = "web-mobile-${DateTime.now().millisecondsSinceEpoch}-${Random().nextInt(1 << 20)}";
  bool _sending = false;

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    _input.clear();
    setState(() {
      _turns.add(_Turn(who: _Who.user, text: text));
      _sending = true;
    });
    _scrollToEnd();

    try {
      final result = await widget.client.sendMessage(
        workspaceId: widget.workspaceId,
        message: text,
        sessionId: _sessionId,
      );
      switch (result.kind) {
        case ChatKind.complete:
          setState(() => _turns.add(_Turn(who: _Who.agent, text: result.reply ?? "", model: result.model)));
        case ChatKind.error:
          setState(() => _turns.add(_Turn(
                who: _Who.agent,
                text: result.fixHint == null ? (result.reply ?? "The request failed.") : "${result.reply}\n\n${result.fixHint}",
                model: result.model,
                failed: true,
              )));
        case ChatKind.confirmAction:
          setState(() => _turns.add(_Turn(
                who: _Who.agent,
                text: result.description ?? "Confirm to continue.",
                model: result.model,
              )));
          await _confirm(result);
        case ChatKind.taskQueued:
          final idx = _turns.length;
          setState(() => _turns.add(_Turn(
                who: _Who.agent,
                text: result.reply?.isNotEmpty == true ? result.reply! : "On it — working on that now.",
                model: result.model,
                taskId: result.taskId,
              )));
          if (result.taskId != null) {
            final reply = await _poll(widget.client, result.taskId!);
            if (mounted) {
              setState(() {
                _turns[idx].text = reply ??
                    "Task queued. Open the Tasks tab to watch it run.";
              });
            }
          }
      }
    } on ApiException catch (e) {
      setState(() => _turns.add(_Turn(who: _Who.agent, text: e.message, failed: true)));
    } finally {
      if (mounted) setState(() => _sending = false);
      _scrollToEnd();
    }
  }

  /// A PROJECT result needs an explicit execute-action call to queue the work.
  Future<void> _confirm(ChatResult result) async {
    try {
      final taskId = await widget.client.executeAction(
        workspaceId: widget.workspaceId,
        intent: result.intent ?? "TASK",
        description: result.description ?? "",
        sessionId: _sessionId,
      );
      if (!mounted) return;
      setState(() => _turns.add(_Turn(
            who: _Who.agent,
            text: "Queued. Open the Tasks tab to watch it run.",
            taskId: taskId,
          )));
    } on ApiException catch (e) {
      if (mounted) setState(() => _turns.add(_Turn(who: _Who.agent, text: e.message, failed: true)));
    }
  }

  /// Long-poll the queued reply up to a few rounds, then hand off to the Tasks
  /// tab — the task page is where progress and artifacts live.
  Future<String?> _poll(PlexoClient client, String taskId) async {
    for (var i = 0; i < 8; i++) {
      try {
        final reply = await client.pollTaskReply(taskId);
        if (reply != null) return reply;
      } on ApiException {
        return null; // fall back to the "open Tasks" hint
      }
    }
    return null;
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return Column(
      children: [
        Expanded(
          child: _turns.isEmpty
              ? _EmptyChat(workspaceName: widget.workspaceName)
              : ListView.builder(
                  controller: _scroll,
                  padding: const EdgeInsets.all(PlexoSpace.s4),
                  itemCount: _turns.length,
                  itemBuilder: (context, i) => _Bubble(
                    turn: _turns[i],
                    onOpenTask: widget.onOpenTask,
                  ),
                ),
        ),
        SafeArea(
          top: false,
          child: Container(
            padding: const EdgeInsets.fromLTRB(PlexoSpace.s3, PlexoSpace.s2, PlexoSpace.s3, PlexoSpace.s2),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: scheme.outlineVariant)),
              color: scheme.surface,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    minLines: 1,
                    maxLines: 6,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _send(),
                    enabled: !_sending,
                    decoration: InputDecoration(
                      hintText: "Message your agent…",
                      hintStyle: text.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: PlexoSpace.s3,
                        vertical: PlexoSpace.s3,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(PlexoRadius.md),
                        borderSide: BorderSide(color: scheme.outlineVariant),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: PlexoSpace.s2),
                _sending
                    ? const Padding(
                        padding: EdgeInsets.all(PlexoSpace.s2),
                        child: SizedBox(
                          height: 22,
                          width: 22,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : IconButton.filled(
                        onPressed: _send,
                        icon: const Icon(Icons.arrow_upward),
                        tooltip: "Send",
                      ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _EmptyChat extends StatelessWidget {
  const _EmptyChat({required this.workspaceName});
  final String workspaceName;

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
            const PlexoMark(size: 56, color: PlexoColor.textSecondary),
            const SizedBox(height: PlexoSpace.s4),
            Text("Message your agent", style: text.titleMedium),
            const SizedBox(height: PlexoSpace.s1),
            Text(
              "Ask a question or describe something to build in $workspaceName.",
              style: text.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.turn, this.onOpenTask});
  final _Turn turn;
  final void Function(String taskId)? onOpenTask;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    final isUser = turn.who == _Who.user;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        margin: const EdgeInsets.only(bottom: PlexoSpace.s3),
        padding: const EdgeInsets.symmetric(horizontal: PlexoSpace.s3, vertical: PlexoSpace.s3),
        decoration: BoxDecoration(
          color: isUser ? scheme.primary : scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(PlexoRadius.md),
          border: turn.failed ? Border.all(color: scheme.error) : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectableText(
              turn.text,
              style: text.bodyMedium?.copyWith(
                color: isUser ? scheme.onPrimary : scheme.onSurface,
              ),
            ),
            if (turn.model != null && !isUser) ...[
              const SizedBox(height: PlexoSpace.s2),
              Text(
                turn.model!,
                style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
            if (turn.taskId != null && onOpenTask != null) ...[
              const SizedBox(height: PlexoSpace.s1),
              TextButton.icon(
                onPressed: () => onOpenTask!(turn.taskId!),
                icon: const Icon(Icons.arrow_forward, size: 16),
                label: const Text("View task"),
                style: TextButton.styleFrom(
                  padding: EdgeInsets.zero,
                  minimumSize: const Size(0, 32),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
