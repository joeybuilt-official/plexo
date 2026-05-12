# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC

"""
Plexo Graphiti sidecar — Phase 3c (ADR 0011).

What ships:
- HMAC-authenticated request boundary (mirrors gmessages-session-refresh-receiver)
- /v1/health readiness probe
- /v1/episodes wired to Graphiti.add_episode
- /v1/search wired to Graphiti.search
- Per-workspace Graphiti instances cached in-process, each with its own
  KuzuDriver pointed at /data/graphiti/<workspace_id>/graph.kuzu (door #4
  isolation per ADR 0010).

Per-workspace LLM + embedder routing:
  Each Graphiti instance's OpenAIEmbedderConfig + LLMConfig point at the
  Plexo inference shim using a workspace-scoped base_url:
    `${PLEXO_INFERENCE_BASE}/ws/<workspace_id>/v1`
  Why URL-routed and not headers: as of graphiti-core 0.29 the public
  EmbedderConfig + LLMConfig surface only forwards `api_key` + `base_url`
  to AsyncOpenAI; `default_headers` is not plumbed through. The Plexo
  inference shim's wsRouter (apps/api/src/routes/inference.ts) reads the
  workspace ID from the URL and synthesizes `X-App-Id: graphiti-sidecar`,
  so Graphiti's locked client surface satisfies auth without any header
  injection trickery.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
import pathlib
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
from graphiti_core.driver.kuzu_driver import KuzuDriver
from graphiti_core.edges import EntityEdge
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.nodes import EntityNode, EpisodeType

logger = logging.getLogger("plexo-graphiti")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="plexo-graphiti", version="0.3.0")

SERVICE_KEY = os.environ.get("PLEXO_SERVICE_KEY", "")
KUZU_DATA_DIR = os.environ.get("KUZU_DATA_DIR", "/data/graphiti")
PLEXO_INFERENCE_BASE = os.environ.get(
    "PLEXO_INFERENCE_BASE",
    "http://plexo-api:8080/api/inference",
).rstrip("/")
# Model identifiers passed to plexo-api's /api/inference/.../v1/chat/completions
# endpoint. plexo-api IGNORES this field and routes by workspace AI settings
# (resolveModel → IntelligentRouter → primaryProvider) — the value here is a
# marker only. `default` makes that intent explicit; the previous
# `plexo-router` name suggested a real router that didn't exist and led to a
# diagnosis dead-end during the 2026-05-10 Phase 7 cutover when the broken
# OLLAMA_INTERNAL_URL fallback path was misread as "the sidecar is hardcoded
# to Ollama". The actual routing lives in plexo-api; this value is the name
# we report in usage telemetry.
GRAPHITI_LLM_MODEL = os.environ.get("GRAPHITI_LLM_MODEL", "default")
GRAPHITI_LLM_SMALL_MODEL = os.environ.get("GRAPHITI_LLM_SMALL_MODEL", "default-small")
GRAPHITI_EMBEDDING_MODEL = os.environ.get("GRAPHITI_EMBEDDING_MODEL", "default-embedding")
HMAC_TS_TOLERANCE_SEC = 300  # 5-min clock-skew window

UUID_RE = (
    "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

import re

_UUID_PAT = re.compile(UUID_RE, re.IGNORECASE)


def _verify_hmac(raw_body: bytes, signature_header: str, ts_header: str) -> tuple[bool, str]:
    if not SERVICE_KEY:
        return False, "PLEXO_SERVICE_KEY not configured on sidecar"
    if not signature_header.startswith("sha256="):
        return False, "missing or malformed X-Plexo-Signature"
    expected = "sha256=" + hmac.new(
        SERVICE_KEY.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature_header):
        return False, "signature mismatch"
    try:
        sent = datetime.fromisoformat(ts_header.replace("Z", "+00:00"))
    except ValueError:
        return False, "invalid X-Plexo-Timestamp"
    if abs((datetime.now(timezone.utc) - sent).total_seconds()) > HMAC_TS_TOLERANCE_SEC:
        return False, "timestamp outside tolerance window"
    return True, ""


async def _require_hmac(request: Request) -> bytes:
    raw_body = await request.body()
    sig = request.headers.get("X-Plexo-Signature", "")
    ts = request.headers.get("X-Plexo-Timestamp", "")
    ok, reason = _verify_hmac(raw_body, sig, ts)
    if not ok:
        raise HTTPException(status_code=401, detail=reason)
    return raw_body


# ---------- Per-workspace Graphiti instance cache ----------

_GRAPHITI_INSTANCES: dict[str, Graphiti] = {}
# Single process-wide lock for both cache mutation (load/evict workspace
# instances) AND graphiti.* operations. Originally split into two locks
# (a cache lock and an op lock); the split caused a race on 2026-05-11
# where workspace B's chat could acquire the cache lock + evict workspace
# A's instance while A's add_episode was mid-flight under the op lock,
# yielding `RuntimeError: cannot schedule new futures after shutdown`
# from kuzu/async_connection.py:171 on the orphaned connection. Collapsing
# both paths through one lock removes the race. Throughput cost is small:
# each add_episode is already ~3s of serialized LLM+embedder+Kuzu work,
# and the cache hit path is a dict lookup (~µs). Cold-load paths (workspace
# switch) take 3-5s for FTS index re-init; that's the expected cost of
# the single-instance policy.
_GRAPHITI_OP_LOCK = asyncio.Lock()


def _validate_workspace_id(workspace_id: str) -> None:
    if not _UUID_PAT.match(workspace_id):
        raise HTTPException(status_code=400, detail="workspace_id must be a UUID")


async def _evict_other_workspaces(keep_ws: str) -> None:
    """Single-instance policy: close + drop any cached Graphiti instance for a
    different workspace. Kuzu's embedded Python binding (kuzu==0.11.3) has no
    client/server transport — every Database handle holds a native filesystem
    lock, and coexisting handles in one process produced repeated silent
    worker crashes during the 2026-05-10 Phase 7 migration attempt (~50
    successful episodes then native deadlock, no Python traceback). Eviction
    cost: ~3-5s of FTS index re-init on next switch. Acceptable for the
    expected workload (one workspace dominates traffic; switches are rare).
    """
    for prior_ws in list(_GRAPHITI_INSTANCES.keys()):
        if prior_ws == keep_ws:
            continue
        prior_inst = _GRAPHITI_INSTANCES.pop(prior_ws)
        try:
            driver = prior_inst.driver
            # Try closing in graphiti-core's preferred order. KuzuDriver in
            # graphiti-core 0.29 doesn't expose a close() method itself but
            # the underlying kuzu.Database may; if neither works the GC
            # finalizer + manual gc.collect() releases the native handle.
            for target in (driver, getattr(driver, "client", None), getattr(driver, "db", None)):
                if target is None:
                    continue
                close_fn = getattr(target, "close", None)
                if close_fn is None:
                    continue
                try:
                    if asyncio.iscoroutinefunction(close_fn):
                        await close_fn()
                    else:
                        close_fn()
                except Exception as close_err:
                    logger.warning(f"graphiti.instance.close_method_failed prior_ws={prior_ws} target={type(target).__name__} err={str(close_err)[:200]}")
            logger.info(f"graphiti.instance.evicted prior_ws={prior_ws} for new_ws={keep_ws}")
        except Exception as e:
            logger.warning(f"graphiti.instance.evict_error prior_ws={prior_ws} err={str(e)[:200]}")
    # Force native handle release before opening a new Kuzu Database in the
    # same process. Without this, GC may delay finalization past the next
    # Database() call, briefly reintroducing the multi-handle condition.
    import gc
    gc.collect()


async def _get_graphiti(workspace_id: str) -> Graphiti:
    """Resolve (and cache) a per-workspace Graphiti instance.

    Single-instance policy: only one workspace's Graphiti is loaded at a time.
    A request for a different workspace evicts the cached one (closes its
    Kuzu DB) before loading the new one. See _evict_other_workspaces for why.

    MUST be called while holding _GRAPHITI_OP_LOCK. The cache mutation +
    eviction path shares the same lock as add_episode/search so a chat for
    workspace B can never evict workspace A's Kuzu connection while A's
    add_episode is mid-flight (observed 2026-05-11 — yielded
    `RuntimeError: cannot schedule new futures after shutdown` from
    kuzu/async_connection.py:171, 213/269 errors during a 10-min window).
    """
    _validate_workspace_id(workspace_id)
    cached = _GRAPHITI_INSTANCES.get(workspace_id)
    if cached is not None:
        return cached

    # Different workspace requested → drop the prior one before opening.
    await _evict_other_workspaces(keep_ws=workspace_id)

    db_dir = pathlib.Path(KUZU_DATA_DIR) / workspace_id
    db_dir.mkdir(parents=True, exist_ok=True)
    driver = KuzuDriver(db=str(db_dir / "graph.kuzu"))
    driver._database = workspace_id

    ws_base_url = f"{PLEXO_INFERENCE_BASE}/ws/{workspace_id}/v1"
    embedder = OpenAIEmbedder(
        config=OpenAIEmbedderConfig(
            api_key=SERVICE_KEY,
            base_url=ws_base_url,
            embedding_model=GRAPHITI_EMBEDDING_MODEL,
        )
    )
    llm_client = OpenAIGenericClient(
        config=LLMConfig(
            api_key=SERVICE_KEY,
            base_url=ws_base_url,
            model=GRAPHITI_LLM_MODEL,
            small_model=GRAPHITI_LLM_SMALL_MODEL,
        )
    )
    cross_encoder = OpenAIRerankerClient(
        config=LLMConfig(
            api_key=SERVICE_KEY,
            base_url=ws_base_url,
            model=GRAPHITI_LLM_SMALL_MODEL,
        )
    )
    graphiti = Graphiti(
        graph_driver=driver,
        llm_client=llm_client,
        embedder=embedder,
        cross_encoder=cross_encoder,
    )
    await graphiti.build_indices_and_constraints()
    # graphiti-core 0.29 KuzuDriver.build_indices_and_constraints is a no-op;
    # the four FTS indices it needs at search time must be created manually.
    # See graphiti_core/graph_queries.py:123 (KUZU branch). Without these
    # the first edge_fulltext_search hit fails with:
    #   "Table RelatesToNode_ doesn't have an index with name edge_name_and_fact"
    try:
        await driver.execute_query("INSTALL fts;")
        logger.info(f"graphiti.fts.install_ok ws={workspace_id}")
    except Exception as e:
        logger.info(f"graphiti.fts.install_skipped ws={workspace_id} err={str(e)[:300]}")
    try:
        await driver.execute_query("LOAD fts;")
        logger.info(f"graphiti.fts.load_ok ws={workspace_id}")
    except Exception as e:
        logger.warning(f"graphiti.fts.load_failed ws={workspace_id} err={str(e)[:300]}")
    for fts_query in (
        "CALL CREATE_FTS_INDEX('Episodic', 'episode_content', ['content', 'source', 'source_description']);",
        "CALL CREATE_FTS_INDEX('Entity', 'node_name_and_summary', ['name', 'summary']);",
        "CALL CREATE_FTS_INDEX('Community', 'community_name', ['name']);",
        "CALL CREATE_FTS_INDEX('RelatesToNode_', 'edge_name_and_fact', ['name', 'fact']);",
    ):
        try:
            await driver.execute_query(fts_query)
            logger.info(f"graphiti.fts.create_ok ws={workspace_id} q={fts_query[:60]}")
        except Exception as e:
            msg = str(e)
            if "already exists" not in msg.lower() and "duplicate" not in msg.lower():
                logger.warning(f"graphiti.fts.create_failed ws={workspace_id} q={fts_query[:60]} err={msg[:300]}")
    _GRAPHITI_INSTANCES[workspace_id] = graphiti
    logger.info(
        "graphiti.instance.created",
        extra={"workspace_id": workspace_id, "db_path": str(db_dir / "graph.kuzu")},
    )
    return graphiti


@app.get("/v1/health")
async def health() -> JSONResponse:
    """Readiness probe. Public — no HMAC required."""
    return JSONResponse(
        {
            "ok": True,
            "service": "plexo-graphiti",
            "kuzu_data_dir": KUZU_DATA_DIR,
            "hmac_configured": bool(SERVICE_KEY),
            "graphiti_version": _safe_graphiti_version(),
            "phase": "3c-integrated",
            "instances_cached": len(_GRAPHITI_INSTANCES),
        }
    )


def _safe_graphiti_version() -> str:
    try:
        from importlib.metadata import version
        return version("graphiti-core")
    except Exception:  # noqa: BLE001 — version probe must not crash health
        return "unknown"


# ---------- /v1/episodes ----------

class EpisodeCreate(BaseModel):
    workspace_id: str
    name: str = Field(default="episode")
    content: str
    source_description: str = Field(default="plexo-bridge")
    episode_type: str = Field(default="message")  # one of EpisodeType values
    reference_time: str | None = None  # ISO timestamp; defaults to now()
    source_metadata: dict = Field(default_factory=dict)


def _episode_type(name: str) -> EpisodeType:
    try:
        return EpisodeType[name]
    except KeyError as e:
        raise HTTPException(
            status_code=400,
            detail=f"unknown episode_type '{name}' (expected one of: {[m.name for m in EpisodeType]})",
        ) from e


def _parse_reference_time(value: str | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail="reference_time must be ISO-8601") from e


@app.post("/v1/episodes")
async def add_episode(request: Request, body: EpisodeCreate) -> JSONResponse:
    await _require_hmac(request)
    async with _GRAPHITI_OP_LOCK:
        graphiti = await _get_graphiti(body.workspace_id)
        result = await graphiti.add_episode(
            name=body.name,
            episode_body=body.content,
            source_description=body.source_description,
            reference_time=_parse_reference_time(body.reference_time),
            source=_episode_type(body.episode_type),
            group_id=body.workspace_id,
        )
    # AddEpisodeResults in graphiti-core 0.29 exposes `episode` (an EpisodicNode)
    # plus `nodes` and `edges` lists. Surface a stable shape for the bridge.
    episode_node = getattr(result, "episode", None)
    return JSONResponse(
        {
            "episode_id": getattr(episode_node, "uuid", None),
            "extracted_facts_count": len(getattr(result, "edges", []) or []),
            "extracted_nodes_count": len(getattr(result, "nodes", []) or []),
        }
    )


# ---------- /v1/search ----------

class SearchRequest(BaseModel):
    workspace_id: str
    query: str
    num_results: int = 10


@app.post("/v1/search")
async def search(request: Request, body: SearchRequest) -> JSONResponse:
    await _require_hmac(request)
    async with _GRAPHITI_OP_LOCK:
        graphiti = await _get_graphiti(body.workspace_id)
        edges = await graphiti.search(
            query=body.query,
            group_ids=[body.workspace_id],
            num_results=body.num_results,
        )
    results = [
        {
            "uuid": getattr(e, "uuid", None),
            "fact": getattr(e, "fact", None),
            "source_node_uuid": getattr(e, "source_node_uuid", None),
            "target_node_uuid": getattr(e, "target_node_uuid", None),
            "valid_at": _isoformat(getattr(e, "valid_at", None)),
            "invalid_at": _isoformat(getattr(e, "invalid_at", None)),
            "created_at": _isoformat(getattr(e, "created_at", None)),
        }
        for e in (edges or [])
    ]
    return JSONResponse({"results": results})


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


# ---------- /v1/triplets (Phase A — ADR 0013 Route A bypass) ----------
#
# Constructs typed EntityNode + EntityEdge + EntityNode and calls
# graphiti.add_triplet directly, skipping the 3-5 internal LLM rounds that
# graphiti.add_episode runs (entity extract, edge extract, dedup, summarize).
# Used by the Phase 7 corpus migration (Personal workspace, 4,193 session+
# pattern rows) to collapse per-row lock-hold from ~30s → ~1s.
#
# Latencies are reported back so pre-mortem #2 (lock-hold not meaningfully
# faster than add_episode) can be falsified during the first 10 calls of
# the migration run.

_VALID_ENTITY_TYPES = {
    "IdentityFact",
    "PreferenceFact",
    "SkillFact",
    "ContextFact",
    "ConstraintFact",
    "Generic",
}
_VALID_MEMORY_TYPES = {"session", "pattern"}


class TripletNode(BaseModel):
    name: str
    type: str
    attributes: dict = Field(default_factory=dict)


class TripletCreate(BaseModel):
    workspace_id: str
    subject: TripletNode
    predicate: str
    object: TripletNode
    source_metadata: dict
    valid_at: str | None = None


def _validate_triplet_node(label: str, node: TripletNode) -> None:
    if node.type not in _VALID_ENTITY_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"{label}.type '{node.type}' not in {sorted(_VALID_ENTITY_TYPES)}",
        )
    if not node.name or not node.name.strip():
        raise HTTPException(status_code=422, detail=f"{label}.name must be non-empty")


def _validate_source_metadata(source_metadata: dict) -> tuple[str, str]:
    plexo_memory_id = source_metadata.get("plexo_memory_id")
    plexo_memory_type = source_metadata.get("plexo_memory_type")
    if not plexo_memory_id or not _UUID_PAT.match(str(plexo_memory_id)):
        raise HTTPException(
            status_code=422,
            detail="source_metadata.plexo_memory_id must be a UUID",
        )
    if plexo_memory_type not in _VALID_MEMORY_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"source_metadata.plexo_memory_type must be one of {sorted(_VALID_MEMORY_TYPES)}",
        )
    return str(plexo_memory_id), str(plexo_memory_type)


def _build_entity_node(workspace_id: str, node: TripletNode, plexo_memory_type: str) -> EntityNode:
    attrs = {**(node.attributes or {}), "plexo_memory_type": plexo_memory_type}
    return EntityNode(
        name=node.name,
        group_id=workspace_id,
        labels=[node.type],
        attributes=attrs,
    )


@app.post("/v1/triplets")
async def add_triplet(request: Request, body: TripletCreate) -> JSONResponse:
    await _require_hmac(request)
    # Validate before acquiring the heavy op lock.
    if not _UUID_PAT.match(body.workspace_id):
        raise HTTPException(status_code=422, detail="workspace_id must be a UUID")
    _validate_triplet_node("subject", body.subject)
    _validate_triplet_node("object", body.object)
    plexo_memory_id, plexo_memory_type = _validate_source_metadata(body.source_metadata)
    if not body.predicate or not body.predicate.strip():
        raise HTTPException(status_code=422, detail="predicate must be non-empty")

    valid_at_dt = _parse_reference_time(body.valid_at)

    lock_wait_start = _now_monotonic_ms()
    async with _GRAPHITI_OP_LOCK:
        lock_wait_ms = _now_monotonic_ms() - lock_wait_start
        write_start = _now_monotonic_ms()
        graphiti = await _get_graphiti(body.workspace_id)

        source_node = _build_entity_node(body.workspace_id, body.subject, plexo_memory_type)
        target_node = _build_entity_node(body.workspace_id, body.object, plexo_memory_type)

        edge_attrs = {
            "plexo_memory_type": plexo_memory_type,
            "plexo_memory_id": plexo_memory_id,
        }
        edge = EntityEdge(
            group_id=body.workspace_id,
            source_node_uuid=source_node.uuid,
            target_node_uuid=target_node.uuid,
            created_at=valid_at_dt,
            valid_at=valid_at_dt,
            name=body.predicate,
            fact=f"{body.subject.name} {body.predicate} {body.object.name}",
            attributes=edge_attrs,
        )

        result = await graphiti.add_triplet(source_node, edge, target_node)
        triplet_write_ms = _now_monotonic_ms() - write_start

    # graphiti.add_triplet returns AddTripletResults(nodes, edges). Prefer the
    # returned edge uuid (graphiti may have replaced ours during dedup); fall
    # back to the uuid we constructed if the result list is unexpectedly empty.
    result_edges = getattr(result, "edges", None) or []
    if result_edges:
        triplet_id = getattr(result_edges[0], "uuid", None) or edge.uuid
    else:
        triplet_id = edge.uuid

    return JSONResponse(
        {
            "triplet_id": triplet_id,
            "latencies": {
                "lock_wait_ms": int(lock_wait_ms),
                "triplet_write_ms": int(triplet_write_ms),
            },
        }
    )


def _now_monotonic_ms() -> int:
    import time
    return int(time.monotonic() * 1000)
