#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC

"""
Phase F nightly cardinality report (ADR 0029).

Connects to FalkorDB, iterates every Cypher graph database, runs
  MATCH (n) RETURN labels(n) AS labels, count(n) AS count
per graph, and writes a tab-separated report to stderr (cron will tee
into the sidecar log stream).

For each (graph, label) pair, also annotates whether the label is
registered in the per-app schema. Unregistered labels surface in the
"unregistered" column — Phase F exit criterion is 7 consecutive nights
of zero unregistered labels before flipping STRICT_SCHEMA default to
true.

Run via cron in the sidecar container:
  0 4 * * *  python3 /app/scripts/cardinality_report.py 2>&1 | logger -t schema-cardinality

Env vars (mirrors main.py):
  FALKORDB_HOST  (default "falkordb")
  FALKORDB_PORT  (default 6379)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Sidecar root on sys.path so `import schema_registry` resolves whether
# the script is run from /app or from a host-side checkout.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import schema_registry  # noqa: E402

try:
    from falkordb import FalkorDB
except ImportError as e:
    print(f"falkordb not installed: {e}", file=sys.stderr)
    sys.exit(2)


HOST = os.environ.get("FALKORDB_HOST", "falkordb")
PORT = int(os.environ.get("FALKORDB_PORT", "6379"))

# Graphs the sidecar creates for its own infrastructure — not user data, so
# unregistered labels here MUST NOT count against the Phase F "7 nights
# zero unregistered" gate. Currently: the BGSAVE probe graph (commit
# `f8cc188`, ADR 0030 Addendum) which holds a synthetic `Probe` node so
# `BGSAVE` has something to flush in the in-process RDB tiers.
SYSTEM_GRAPHS: frozenset[str] = frozenset({"plexo-bgsave-probe"})


def _infer_app_from_graph_name(graph_name: str) -> str:
    """FalkorDB graph names follow either:
      - "<workspace_id>"           — legacy plexo (per main.py:148-205)
      - "<app>:<workspace_id>"     — Phase F namespaced
    Anything before the first colon is treated as the app name; absent
    colon defaults to "plexo" (back-compat)."""
    if ":" in graph_name:
        return graph_name.split(":", 1)[0]
    return "plexo"


def main() -> int:
    client = FalkorDB(host=HOST, port=PORT)
    # FalkorDB exposes `list_graphs()` returning all Cypher graph names.
    try:
        graph_names = client.list_graphs()
    except Exception as e:  # noqa: BLE001
        print(f"falkordb list_graphs failed: {e}", file=sys.stderr)
        return 2

    print("graph\tapp\tlabel\tcount\tunregistered", file=sys.stderr)
    total_unregistered = 0
    for graph_name in sorted(graph_names):
        if graph_name in SYSTEM_GRAPHS:
            # Still emit a row for visibility, but mark `system` so the
            # Phase F gate-script can filter without false-positives.
            print(f"{graph_name}\t-\t-\t-\tsystem", file=sys.stderr)
            continue
        app = _infer_app_from_graph_name(graph_name)
        registered = set(schema_registry.registered_labels(app))
        graph = client.select_graph(graph_name)
        try:
            res = graph.query("MATCH (n) RETURN labels(n) AS labels, count(n) AS c")
        except Exception as e:  # noqa: BLE001
            print(f"{graph_name}\t{app}\tQUERY_ERROR\t0\t{e}", file=sys.stderr)
            continue
        for row in res.result_set:
            labels = row[0] or []
            count = row[1]
            # Cypher labels(n) returns a list; flatten one row per label.
            for label in labels:
                unregistered = "yes" if label not in registered else "no"
                if unregistered == "yes":
                    total_unregistered += 1
                print(f"{graph_name}\t{app}\t{label}\t{count}\t{unregistered}", file=sys.stderr)

    print(f"# total_unregistered_label_occurrences={total_unregistered}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
