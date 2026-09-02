# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC

"""Phase 11 schema-compat probe stub.

Stand-in for plexo-api's inference shim during the upstream-watcher
schema-compat probe (see graphiti-migration/phase-11-design.md §"Probe
stub").

Returns deterministic, schema-compliant responses on:
  POST /api/inference/ws/{ws}/v1/embeddings        → PROBE_EMBEDDING_DIM vector
  POST /api/inference/ws/{ws}/v1/chat/completions  → canonical extraction shape

The point is to test graphiti's pipeline + the FalkorDB graph against a
new graphiti-core version. LLM quality is NOT the variable under test
here — that's caught downstream by prod observation, not the bump probe.

Auth mirrors apps/api's `requireServiceKey` (see
apps/api/src/middleware/service-key-auth.ts): `Authorization: Bearer
<PLEXO_SERVICE_KEY>` plus an `X-App-Id` header. That is what the sidecar
actually sends — its LLM/embedder calls go out through graphiti-core's
OpenAI clients, which only know how to send a Bearer api_key. The stub
previously demanded an HMAC signature instead, which no caller on this
path produces, so every inference call 401'd and the probe could never
have ingested an episode.

Run:
  PLEXO_SERVICE_KEY=<key> uvicorn probe-stub:app --host 127.0.0.1 --port 8090
"""
from __future__ import annotations

import hmac
import json
import os
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

SERVICE_KEY = os.environ.get("PLEXO_SERVICE_KEY", "")
# Must match the sidecar's GRAPHITI_EMBEDDING_DIM for the run under probe: the
# FalkorDB vector index is built at that dimension and a mismatch makes every
# search miss. probe.sh sets both from one variable.
EMBEDDING_DIM = int(os.environ.get("PROBE_EMBEDDING_DIM", "256"))

app = FastAPI(title="phase-11 probe stub", version="0.1.0")


async def _require_service_key(request: Request) -> bytes:
    """Bearer service-key check, mirroring apps/api `requireServiceKey`."""
    raw = await request.body()
    if not SERVICE_KEY:
        # Stub mode — operator forgot to set the key. Fail loudly so the
        # probe surfaces config errors instead of silently passing.
        raise HTTPException(401, detail="PLEXO_SERVICE_KEY not configured")

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, detail="missing or malformed Authorization: Bearer")
    if not hmac.compare_digest(auth[len("Bearer "):], SERVICE_KEY):
        raise HTTPException(401, detail="invalid service key")

    return raw


@app.get("/v1/health")
async def health() -> JSONResponse:
    """Public health probe; matches sidecar's own /v1/health shape."""
    return JSONResponse({
        "ok": True,
        "service": "probe-stub",
        "service_key_configured": bool(SERVICE_KEY),
    })


@app.post("/api/inference/ws/{workspace_id}/v1/embeddings")
async def embeddings(workspace_id: str, request: Request) -> JSONResponse:
    raw = await _require_service_key(request)
    body = json.loads(raw or b"{}")
    inputs = body.get("input", [])
    if isinstance(inputs, str):
        inputs = [inputs]
    # Deterministic vector — alternating 0.1 / -0.1 so cosine similarity is
    # non-degenerate but identical across runs.
    vec = [0.1 if i % 2 == 0 else -0.1 for i in range(EMBEDDING_DIM)]
    data = [{"object": "embedding", "index": i, "embedding": vec} for i in range(len(inputs))]
    return JSONResponse({
        "object": "list",
        "data": data,
        "model": body.get("model", "probe-stub-embed"),
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    })


@app.post("/api/inference/ws/{workspace_id}/v1/chat/completions")
async def chat_completions(workspace_id: str, request: Request) -> JSONResponse:
    raw = await _require_service_key(request)
    body = json.loads(raw or b"{}")

    fmt = body.get("response_format") or {}
    if fmt.get("type") == "json_schema":
        schema = (fmt.get("json_schema") or {}).get("schema") or {}
        canned = _canonical_response_for_schema(schema)
        content = json.dumps(canned)
    else:
        # Text-mode fallback. graphiti's primary path is json_schema, but a
        # few summarise calls are text. Keep the response short + stable.
        content = "Probe-stub deterministic summary."

    return JSONResponse({
        "id": "chatcmpl-probe-stub",
        "object": "chat.completion",
        "created": int(datetime.now(UTC).timestamp()),
        "model": body.get("model", "probe-stub-chat"),
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    })


# Two distinct, deterministic entity names. graphiti's edge extraction names
# its endpoints (`source_entity_name` / `target_entity_name`) rather than
# indexing them, so a stub that answers every string field with one constant
# makes both endpoints the same entity — graphiti then logs "Dropping self-edge"
# and the graph ends up with zero edges. `/v1/search` returns edges, so the
# whole recall path (RediSearch FTS + vector) would go untested and the probe
# would pass on an empty result set. These two names are what make an edge
# survive.
PROBE_ENTITIES = ("probe-entity-alpha", "probe-entity-beta")
# Field-name-driven, not schema-version-driven: these names have been stable
# across graphiti-core's extraction models, and anything not listed still falls
# through to the generic type-based default below.
_NAMED_VALUES = {
    "source_entity_name": PROBE_ENTITIES[0],
    "target_entity_name": PROBE_ENTITIES[1],
    "relation_type": "PROBE_LINKED_TO",
    "fact": f"{PROBE_ENTITIES[0]} is linked to {PROBE_ENTITIES[1]} (probe fixture).",
}


def _canonical_response_for_schema(
    schema: dict[str, Any], index: int = 0
) -> dict[str, Any]:
    """Synthesize a minimal schema-compliant object.

    Walks the top-level required properties + emits a deterministic value
    matching each declared type. Arrays get two stub elements (see
    PROBE_ENTITIES); nested objects recurse. Covers the graphiti-core 0.29
    pipeline schemas (extracted_entities, extracted_edges, summary, dedup,
    attributes) without per-version chasing — every new shape passes as long as
    the JSON Schema is well-formed.

    `index` is the position of this object within its parent array, so a list
    of entities comes back with distinguishable names.
    """
    if schema.get("type") != "object":
        return {}
    out: dict[str, Any] = {}
    properties = schema.get("properties") or {}
    required = schema.get("required") or list(properties.keys())
    defs = {**(schema.get("$defs") or {}), **(schema.get("definitions") or {})}
    for key in required:
        prop = properties.get(key, {})
        out[key] = _value_for(prop, defs, index=index, field=key)
    return out


def _value_for(
    prop: dict[str, Any],
    defs: dict[str, Any],
    index: int = 0,
    field: str | None = None,
) -> Any:
    if "$ref" in prop:
        ref = prop["$ref"].rsplit("/", 1)[-1]
        prop = defs.get(ref, {})
    t = prop.get("type")
    if isinstance(t, list):
        # nullable union — pick the non-null type
        t = next((x for x in t if x != "null"), "string")
    if t == "string":
        if field in _NAMED_VALUES:
            return _NAMED_VALUES[field]
        if field == "name":
            return PROBE_ENTITIES[index % len(PROBE_ENTITIES)]
        return prop.get("default", "probe-stub-string")
    if t == "integer":
        return prop.get("default", 0)
    if t == "number":
        return prop.get("default", 0.0)
    if t == "boolean":
        return prop.get("default", False)
    if t == "array":
        items = prop.get("items") or {}
        # Two elements, so an entity list yields two distinct entities and the
        # edge between them is not a self-edge.
        return [_value_for(items, defs, index=i, field=field) for i in range(2)]
    if t == "object":
        return _canonical_response_for_schema({**prop, "type": "object"}, index=index)
    if "enum" in prop and prop["enum"]:
        return prop["enum"][0]
    return None
