// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Selected-workspace state. The API scopes tasks, conversations, and chat to a
// workspaceId, so the authenticated shell needs exactly one workspace in focus.
// The choice is persisted so a relaunch lands back where the user left off.

import "package:shared_preferences/shared_preferences.dart";

import "../api/models.dart";

class WorkspaceStore {
  WorkspaceStore._(this._prefs, this._workspaces, this._selectedId);

  static const _kSelected = "plexo.workspaceId";

  final SharedPreferences _prefs;
  List<Workspace> _workspaces;
  String? _selectedId;

  static Future<WorkspaceStore> load() async {
    final prefs = await SharedPreferences.getInstance();
    return WorkspaceStore._(prefs, const [], prefs.getString(_kSelected));
  }

  List<Workspace> get workspaces => _workspaces;
  String? get selectedId => _selectedId;

  Workspace? get selected {
    if (_selectedId == null) return null;
    for (final w in _workspaces) {
      if (w.id == _selectedId) return w;
    }
    return null;
  }

  /// Replace the list, keeping the persisted selection when it still exists,
  /// otherwise defaulting to the first workspace.
  Future<void> setWorkspaces(List<Workspace> next) async {
    _workspaces = next;
    final stillValid = next.any((w) => w.id == _selectedId);
    if (!stillValid) {
      _selectedId = next.isNotEmpty ? next.first.id : null;
      await _persist();
    }
  }

  Future<void> select(String workspaceId) async {
    _selectedId = workspaceId;
    await _persist();
  }

  Future<void> _persist() async {
    final id = _selectedId;
    if (id == null) {
      await _prefs.remove(_kSelected);
    } else {
      await _prefs.setString(_kSelected, id);
    }
  }
}
