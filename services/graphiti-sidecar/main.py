# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC

"""
Plexo Graphiti sidecar — ADR 0015 (FalkorDB backend).

What ships:
- HMAC-authenticated request boundary (mirrors gmessages-session-refresh-receiver)
- /v1/health readiness probe
- /v1/episodes wired to Graphiti.add_episode
- /v1/search wired to Graphiti.search
- /v1/triplets fast-path (Phase A bypass) for typed entity+edge writes
- Per-workspace Graphiti instances cached in-process, each with its own
  FalkorDriver pointed at the shared FalkorDB server, isolated by Cypher
  graph database name = workspace_id. Multiple workspaces coexist freely
  (FalkorDB is a true multi-tenant Redis-protocol server — no native
  filesystem locks, unlike Kuzu).

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
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
from graphiti_core.driver.falkordb_driver import FalkorDriver
from graphiti_core.edges import EntityEdge
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.nodes import EntityNode, EpisodeType

import schema_registry

logger = logging.getLogger("plexo-graphiti")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="plexo-graphiti", version="0.4.0-falkordb")

SERVICE_KEY = os.environ.get("PLEXO_SERVICE_KEY", "")
FALKORDB_HOST = os.environ.get("FALKORDB_HOST", "falkordb")
FALKORDB_PORT = int(os.environ.get("FALKORDB_PORT", "6379"))
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


# ---------- Phase F schema registry wiring (ADR 0029) ----------
#
# App identity rules (back-compat with pre-Phase-F callers):
# 1. Explicit body field `app` wins.
# 2. Otherwise read `X-Plexo-App` header.
# 3. Otherwise default to "plexo" — every existing endpoint belongs to the
#    plexo app, so omitting the field on a legacy bridge request is fine.
#
# STRICT_SCHEMA is read on every request (not cached) so an operator can
# flip it via compose env-update + container restart without a deploy.

def _resolve_app(request: Request, body_app: str | None = None) -> str:
    if body_app:
        return body_app
    header_app = request.headers.get("X-Plexo-App")
    if header_app:
        return header_app
    return "plexo"


def _schema_check_node(app: str, label: str, properties: dict | None) -> None:
    """Wrap schema_registry.validate so a ValidationError surfaces as
    HTTPException(422). Called BEFORE acquiring _ws_lock — validation is
    cheap and we want fast rejection."""
    try:
        schema_registry.validate(app, label, properties)
    except schema_registry.ValidationError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


# ---------- Per-workspace Graphiti instance cache ----------
#
# FalkorDB allows true multi-tenant operation: one server, one connection
# pool, separate Cypher graph database per workspace. No native filesystem
# lock (unlike kuzu==0.11.3), so multiple workspaces' Graphiti instances
# coexist freely in this process — no eviction logic needed.
#
# Locking model:
# - One asyncio.Lock per workspace_id, lazily allocated. Serializes writes
#   to a single workspace (graphiti's internal LLM resolve + Cypher write
#   must not interleave on the same workspace), but lets DIFFERENT
#   workspaces run concurrently. This is the change that unblocks backfill
#   without crippling user chat latency.

_GRAPHITI_INSTANCES: dict[str, Graphiti] = {}
_WORKSPACE_LOCKS: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def _validate_workspace_id(workspace_id: str) -> None:
    if not _UUID_PAT.match(workspace_id):
        raise HTTPException(status_code=400, detail="workspace_id must be a UUID")


def _ws_lock(workspace_id: str) -> asyncio.Lock:
    """Per-workspace lock. defaultdict creation is safe under CPython's
    single-threaded asyncio event loop."""
    return _WORKSPACE_LOCKS[workspace_id]


async def _get_graphiti(workspace_id: str) -> Graphiti:
    """Resolve (and cache) a per-workspace Graphiti instance.

    All workspaces coexist in-process; FalkorDriver targets database=
    workspace_id so each workspace is an isolated Cypher graph in the
    shared FalkorDB server.

    MUST be called while holding _ws_lock(workspace_id).
    """
    _validate_workspace_id(workspace_id)
    cached = _GRAPHITI_INSTANCES.get(workspace_id)
    if cached is not None:
        return cached

    driver = FalkorDriver(
        host=FALKORDB_HOST,
        port=FALKORDB_PORT,
        database=workspace_id,
    )

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
    # FalkorDriver auto-schedules build_indices_and_constraints in __init__;
    # call again to ensure it ran in our event loop context (idempotent).
    await graphiti.build_indices_and_constraints()
    _GRAPHITI_INSTANCES[workspace_id] = graphiti
    logger.info(
        "graphiti.instance.created",
        extra={"workspace_id": workspace_id, "backend": "falkordb"},
    )
    return graphiti


@app.get("/v1/health")
async def health() -> JSONResponse:
    """Readiness probe. Public — no HMAC required."""
    return JSONResponse(
        {
            "ok": True,
            "service": "plexo-graphiti",
            "falkordb_host": FALKORDB_HOST,
            "falkordb_port": FALKORDB_PORT,
            "hmac_configured": bool(SERVICE_KEY),
            "graphiti_version": _safe_graphiti_version(),
            "backend": "falkordb",
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
    # Phase F: optional explicit app identity. Defaults to header X-Plexo-App
    # else "plexo" (back-compat for the existing bridge).
    app: str | None = None


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
    # Phase F validation BEFORE the heavy lock. The Episodic label's required
    # props are content + source_description (see schemas/plexo.yaml); both
    # are pydantic-required on EpisodeCreate so they're guaranteed present
    # here. The check is the registry's "this app/label is registered"
    # gate — useful when STRICT_SCHEMA flips on and a non-plexo caller hits
    # /v1/episodes without first registering its schema.
    resolved_app = _resolve_app(request, body.app)
    _schema_check_node(
        resolved_app,
        "Episodic",
        {"content": body.content, "source_description": body.source_description},
    )
    async with _ws_lock(body.workspace_id):
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
    async with _ws_lock(body.workspace_id):
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
    app: str | None = None  # Phase F; defaults to header / "plexo"


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

    # Phase F per-app schema check (ADR 0029). The triplet endpoint always
    # writes node `name` + the merged attributes that include
    # `plexo_memory_type`. Sub/obj go through the same registered-label gate.
    resolved_app = _resolve_app(request, body.app)
    sub_props = {**(body.subject.attributes or {}), "name": body.subject.name, "plexo_memory_type": plexo_memory_type}
    obj_props = {**(body.object.attributes or {}), "name": body.object.name, "plexo_memory_type": plexo_memory_type}
    _schema_check_node(resolved_app, body.subject.type, sub_props)
    _schema_check_node(resolved_app, body.object.type, obj_props)

    valid_at_dt = _parse_reference_time(body.valid_at)

    lock_wait_start = _now_monotonic_ms()
    async with _ws_lock(body.workspace_id):
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
