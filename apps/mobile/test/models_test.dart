// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Pure model-parsing tests for the API boundary. These pin the contract shapes
// the screens depend on — the parts of the API that are easy to drift:
//   - timestamps from tz-naive columns (no Z) must parse as UTC
//   - numeric-as-string columns (costUsdNumeric) must parse to double
//   - ChatResult must branch on the `status` discriminator, including the
//     credential-install response that omits `status` entirely

import "package:flutter_test/flutter_test.dart";
import "package:plexo_mobile/src/api/models.dart";

void main() {
  group("Workspace", () {
    test("parses the 4-field summary and falls back on a blank name", () {
      final w = Workspace.fromJson({
        "id": "11111111-1111-1111-1111-111111111111",
        "name": "  ",
        "ownerId": "22222222-2222-2222-2222-222222222222",
        "createdAt": "2026-01-02T03:04:05.000",
      });
      expect(w.id, "11111111-1111-1111-1111-111111111111");
      expect(w.name, "(unnamed workspace)");
      // Naive timestamp (no Z/offset) is treated as UTC.
      expect(w.createdAt!.isUtc, isFalse); // converted to local
      expect(w.createdAt!.toUtc().hour, 3);
    });
  });

  group("Task", () {
    test("reads the description from context and parses costUsdNumeric string", () {
      final t = Task.fromJson({
        "id": "01ABC",
        "workspaceId": "11111111-1111-1111-1111-111111111111",
        "type": "automation",
        "status": "running",
        "source": "dashboard",
        "context": {"description": "make a snake game"},
        "costUsdNumeric": "0.215817",
        "routedProvider": "litellm",
        "routedModel": "auto",
      });
      expect(t.description, "make a snake game");
      expect(t.costUsd, closeTo(0.215817, 1e-9));
      expect(t.isActive, isTrue);
      expect(t.isTerminal, isFalse);
    });

    test("terminal classification", () {
      Task withStatus(String s) => Task.fromJson({
            "id": "x",
            "workspaceId": "w",
            "type": "automation",
            "status": s,
            "source": "dashboard",
            "context": const {},
          });
      expect(withStatus("complete").isTerminal, isTrue);
      expect(withStatus("failed").isTerminal, isTrue);
      expect(withStatus("awaiting_approval").isTerminal, isFalse);
      expect(withStatus("queued").isActive, isTrue);
    });
  });

  group("TaskDetail", () {
    test("parses steps alongside the task", () {
      final d = TaskDetail.fromJson({
        "task": {
          "id": "01ABC",
          "workspaceId": "w",
          "type": "automation",
          "status": "complete",
          "source": "dashboard",
          "context": const {},
        },
        "steps": [
          {"id": "s1", "stepNumber": 1, "state": "completed", "stepType": "llm_generation", "outcome": "wrote file"},
        ],
        "events": const [],
        "approval": null,
      });
      expect(d.steps, hasLength(1));
      expect(d.steps.first.stepNumber, 1);
      expect(d.steps.first.outcome, "wrote file");
    });
  });

  group("ChatResult", () {
    test("task_queued carries the taskId", () {
      final r = ChatResult.fromJson({
        "status": "task_queued",
        "taskId": "01TASK",
        "task": {"id": "01TASK", "displayName": "make a snake game"},
        "model": "litellm/auto",
      });
      expect(r.kind, ChatKind.taskQueued);
      expect(r.taskId, "01TASK");
    });

    test("soft AI error is HTTP 200 with status:error", () {
      final r = ChatResult.fromJson({
        "status": "error",
        "reply": "Provider rejected the key.",
        "fixLabel": "Update API key",
      });
      expect(r.kind, ChatKind.error);
      expect(r.fixHint, "Update API key");
    });

    test("confirm_action surfaces intent + description", () {
      final r = ChatResult.fromJson({
        "status": "confirm_action",
        "intent": "PROJECT",
        "description": "let's start a project: build a snake game",
      });
      expect(r.kind, ChatKind.confirmAction);
      expect(r.intent, "PROJECT");
    });

    test("a response with no status (credential install) is treated as complete", () {
      final r = ChatResult.fromJson({"reply": "Connected Gmail.", "intent": "CONVERSATION"});
      expect(r.kind, ChatKind.complete);
      expect(r.reply, "Connected Gmail.");
    });
  });
}
