# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC

"""
Plexo Graphiti sidecar — Phase 2 scaffold (ADR 0011).

Phase 2 ships:
- HMAC-authenticated request boundary (mirrors gmessages-session-refresh-receiver)
- /v1/health readiness probe
- /v1/episodes + /v1/search stub endpoints (501 Not Implemented; wired in Phase 3)

Phase 3 fills in the Graphiti + Kuzu integration once schema mapping is decided.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="plexo-graphiti", version="0.1.0")

SERVICE_KEY = os.environ.get("PLEXO_SERVICE_KEY", "")
KUZU_DATA_DIR = os.environ.get("KUZU_DATA_DIR", "/data/graphiti")
HMAC_TS_TOLERANCE_SEC = 300  # 5 minutes; matches typical clock-skew window


def _verify_hmac(raw_body: bytes, signature_header: str, ts_header: str) -> tuple[bool, str]:
    """Return (ok, reason) so the caller can produce a useful 401."""
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


@app.get("/v1/health")
async def health() -> JSONResponse:
    """Readiness probe. Public — no HMAC required."""
    return JSONResponse(
        {
            "ok": True,
            "service": "plexo-graphiti",
            "kuzu_data_dir": KUZU_DATA_DIR,
            "hmac_configured": bool(SERVICE_KEY),
            "phase": "2-scaffold",
        }
    )


class EpisodeCreate(BaseModel):
    workspace_id: str
    content: str
    episode_type: str = "message"
    source_metadata: dict = {}


@app.post("/v1/episodes")
async def add_episode(request: Request, body: EpisodeCreate) -> JSONResponse:
    await _require_hmac(request)
    # Phase 3: wire Graphiti.add_episode here. Phase 2 returns 501 so the bridge
    # package can be exercised end-to-end via /v1/health while the real
    # extraction path is still being designed.
    raise HTTPException(status_code=501, detail="add_episode wired in Phase 3")


class SearchRequest(BaseModel):
    workspace_id: str
    query: str
    num_results: int = 10


@app.post("/v1/search")
async def search(request: Request, body: SearchRequest) -> JSONResponse:
    await _require_hmac(request)
    raise HTTPException(status_code=501, detail="search wired in Phase 3")
