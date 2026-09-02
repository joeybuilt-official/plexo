# SPDX-License-Identifier: MIT
# Plexo Graphiti sidecar (ADR 0011). Phase 2: scaffold; Phase 3 adds Graphiti deps.

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY services/graphiti-sidecar/requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

COPY services/graphiti-sidecar/ /app/

# Single uvicorn worker. The original reason was Kuzu's single-writer-per-DB-file
# embedded mode; Kuzu is gone (ADR 0010 moved the graph to FalkorDB), but the
# constraint survives the swap for a different reason: main.py serialises writes
# with `_ws_lock(workspace_id)`, an in-process asyncio lock. A second worker is a
# second process, so the lock would not span it and two episode writes to one
# workspace could interleave. Concurrency comes from async I/O within the one
# worker.
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/v1/health').read()" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
