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
from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.nodes import EpisodeType

logger = logging.getLogger("plexo-graphiti")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="plexo-graphiti", version="0.3.0")

SERVICE_KEY = os.environ.get("PLEXO_SERVICE_KEY", "")
KUZU_DATA_DIR = os.environ.get("KUZU_DATA_DIR", "/data/graphiti")
PLEXO_INFERENCE_BASE = os.environ.get(
    "PLEXO_INFERENCE_BASE",
    "http://plexo-api:8080/api/inference",
).rstrip("/")
GRAPHITI_LLM_MODEL = os.environ.get("GRAPHITI_LLM_MODEL", "plexo-router")
GRAPHITI_LLM_SMALL_MODEL = os.environ.get("GRAPHITI_LLM_SMALL_MODEL", "plexo-router-small")
GRAPHITI_EMBEDDING_MODEL = os.environ.get("GRAPHITI_EMBEDDING_MODEL", "plexo-embeddings")
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
_GRAPHITI_LOCK = asyncio.Lock()


def _validate_workspace_id(workspace_id: str) -> None:
    if not _UUID_PAT.match(workspace_id):
        raise HTTPException(status_code=400, detail="workspace_id must be a UUID")


async def _get_graphiti(workspace_id: str) -> Graphiti:
    """Resolve (and cache) a per-workspace Graphiti instance.

    Each workspace gets its own Kuzu DB file under KUZU_DATA_DIR/<ws>/graph.kuzu
    plus its own LLM/embedder client pinned to the workspace's inference URL.
    """
    _validate_workspace_id(workspace_id)
    async with _GRAPHITI_LOCK:
        cached = _GRAPHITI_INSTANCES.get(workspace_id)
        if cached is not None:
            return cached

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
            await driver.execute_query("INSTALL fts;", {})
        except Exception as e:
            logger.debug("graphiti.fts.install_skipped", extra={"workspace_id": workspace_id, "err": str(e)[:200]})
        try:
            await driver.execute_query("LOAD fts;", {})
        except Exception as e:
            logger.debug("graphiti.fts.load_skipped", extra={"workspace_id": workspace_id, "err": str(e)[:200]})
        for fts_query in (
            "CALL CREATE_FTS_INDEX('Episodic', 'episode_content', ['content', 'source', 'source_description']);",
            "CALL CREATE_FTS_INDEX('Entity', 'node_name_and_summary', ['name', 'summary']);",
            "CALL CREATE_FTS_INDEX('Community', 'community_name', ['name']);",
            "CALL CREATE_FTS_INDEX('RelatesToNode_', 'edge_name_and_fact', ['name', 'fact']);",
        ):
            try:
                await driver.execute_query(fts_query, {})
            except Exception as e:
                msg = str(e)
                # Idempotent path: a prior run created the index; ignore.
                if "already exists" not in msg.lower() and "duplicate" not in msg.lower():
                    logger.warning(
                        "graphiti.fts.create_failed",
                        extra={"workspace_id": workspace_id, "query": fts_query, "err": msg[:300]},
                    )
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
