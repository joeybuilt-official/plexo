#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC

"""
Phase B2 conversation-threading backfill (ADR 0021).

One-shot migration that reads `conversations` rows from plexo postgres
for a single workspace and materializes the corresponding graph:

  (m:Message {id, source, message, created_at, ...})
    -[:IN_SESSION]-> (s:Session {id, source, session_key, last_activity_at})

Plus the sibling chain: each message MERGE's a (:NEXT) edge to the
previous message (by created_at) inside the same session.

Idempotent — all writes are MERGE-on-id; re-running the script is a
no-op once the graph is caught up. Resumable via `--offset N` so a
long run can be split into shifts without restarting from row 0.

Usage:
  # Install pg client into the sidecar's venv first:
  pip install asyncpg

  # Then run from inside the sidecar container (FALKORDB_HOST is set):
  python3 /app/migrations/backfill_conversations.py \\
      --workspace-id 12345678-1234-1234-1234-123456789012 \\
      --pg-dsn postgres://plexo:plexo@plexo-postgres:5432/plexo \\
      --batch-size 500

  # Resume from a known offset:
  python3 /app/migrations/backfill_conversations.py \\
      --workspace-id 12345678-1234-1234-1234-123456789012 \\
      --pg-dsn postgres://... \\
      --offset 12000

Env vars (mirrors main.py):
  FALKORDB_HOST     default "falkordb"
  FALKORDB_PORT     default 6379

Notes:
  - This script writes DIRECTLY to FalkorDB. It bypasses the sidecar HTTP
    layer (no schema_registry check). Use only against a workspace whose
    Message/Session labels are already registered (plexo schema includes
    them as of 2026-05-13).
  - Postgres remains the source of truth. If the backfill crashes mid-
    run, no postgres state changes; rerun from --offset.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import asyncpg  # type: ignore
except ImportError:
    sys.stderr.write(
        "asyncpg not installed; run `pip install asyncpg` in the sidecar venv.\n"
    )
    sys.exit(2)

try:
    from falkordb.asyncio import FalkorDB
except ImportError:
    sys.stderr.write(
        "falkordb.asyncio not available; reinstall falkordb>=1.6.1.\n"
    )
    sys.exit(2)


FALKORDB_HOST = os.environ.get("FALKORDB_HOST", "falkordb")
FALKORDB_PORT = int(os.environ.get("FALKORDB_PORT", "6379"))


def _json_or_none(v):
    """attachments + channel_ref come back from postgres as already-decoded
    Python objects (asyncpg auto-decodes jsonb). Re-serialize to a string
    for FalkorDB property storage."""
    if v is None:
        return None
    return json.dumps(v)


def _message_props(row) -> dict:
    """Build the Message node property bag from a postgres row."""
    props: dict = {
        "source": row["source"],
        "message": row["message"],
        "created_at": row["created_at"].isoformat(),
        "status": row["status"],
    }
    if row["reply"] is not None:
        props["reply"] = row["reply"]
    if row["error_msg"] is not None:
        props["error_msg"] = row["error_msg"]
    if row["intent"] is not None:
        props["intent"] = row["intent"]
    if row["task_id"] is not None:
        props["task_id"] = row["task_id"]
    cr = _json_or_none(row["channel_ref"])
    if cr is not None:
        props["channel_ref"] = cr
    at = _json_or_none(row["attachments"])
    if at is not None and at != "[]":
        props["attachments"] = at
    return props


def _session_props(row) -> dict:
    return {
        "source": row["source"],
        "session_key": row["session_id"] or row["id"],
        "last_activity_at": row["created_at"].isoformat(),
    }


async def backfill(
    workspace_id: str,
    pg_dsn: str,
    batch_size: int,
    offset: int,
) -> int:
    """Returns total rows processed."""
    pg = await asyncpg.connect(pg_dsn)
    falkor = FalkorDB(host=FALKORDB_HOST, port=FALKORDB_PORT)
    graph = falkor.select_graph(workspace_id)

    # Per-session tail tracker — last seen Message id keyed by session id.
    # Persistent across batches; on resume from --offset we seed it on the
    # fly from the first row of each session we encounter (which means the
    # FIRST batch after a resume will skip emitting NEXT for the first row
    # of any session that began in a prior batch — acceptable: re-running
    # the script from offset 0 closes the gap, and MERGE makes it safe).
    last_msg_by_session: dict[str, str] = {}

    total = 0
    cur = offset
    while True:
        rows = await pg.fetch(
            """
            SELECT id, workspace_id, session_id, source, message, reply,
                   error_msg, status, intent, task_id, channel_ref,
                   attachments, created_at
              FROM conversations
             WHERE workspace_id = $1
             ORDER BY created_at ASC, id ASC
             LIMIT $2 OFFSET $3
            """,
            workspace_id,
            batch_size,
            cur,
        )
        if not rows:
            break

        for row in rows:
            msg_id = row["id"]
            session_id = row["session_id"] or msg_id

            # MERGE Message
            await graph.query(
                "MERGE (m:Message {id: $id}) SET m += $props",
                {"id": msg_id, "props": _message_props(row)},
            )
            # MERGE Session
            await graph.query(
                "MERGE (s:Session {id: $id}) SET s += $props",
                {"id": session_id, "props": _session_props(row)},
            )
            # MERGE IN_SESSION
            await graph.query(
                "MATCH (m:Message {id: $mid}), (s:Session {id: $sid}) "
                "MERGE (m)-[:IN_SESSION]->(s)",
                {"mid": msg_id, "sid": session_id},
            )
            # MERGE NEXT from prior message in same session (if any)
            prev = last_msg_by_session.get(session_id)
            if prev is not None and prev != msg_id:
                await graph.query(
                    "MATCH (a:Message {id: $a}), (b:Message {id: $b}) "
                    "MERGE (a)-[:NEXT]->(b)",
                    {"a": prev, "b": msg_id},
                )
            last_msg_by_session[session_id] = msg_id

            total += 1

        cur += len(rows)
        sys.stderr.write(f"backfill: ws={workspace_id} processed={total} cursor={cur}\n")
        sys.stderr.flush()

    await pg.close()
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase B2 conversation backfill")
    parser.add_argument("--workspace-id", required=True, help="UUID")
    parser.add_argument(
        "--pg-dsn",
        default=os.environ.get("PLEXO_API_DATABASE_URL")
        or os.environ.get("DATABASE_URL"),
        help="postgres DSN (or env PLEXO_API_DATABASE_URL / DATABASE_URL)",
    )
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--offset", type=int, default=0, help="resume offset")
    args = parser.parse_args()

    if not args.pg_dsn:
        sys.stderr.write("error: --pg-dsn (or env PLEXO_API_DATABASE_URL) required\n")
        sys.exit(2)

    total = asyncio.run(
        backfill(
            workspace_id=args.workspace_id,
            pg_dsn=args.pg_dsn,
            batch_size=args.batch_size,
            offset=args.offset,
        )
    )
    sys.stderr.write(f"backfill: DONE total={total}\n")


if __name__ == "__main__":
    main()
