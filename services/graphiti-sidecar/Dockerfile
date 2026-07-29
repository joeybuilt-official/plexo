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

# Single uvicorn worker — Kuzu's embedded mode requires single-writer per DB
# file, and concurrency comes from async I/O within one worker. Pre-mortem #2
# of ADR 0011 covers the alternate (Kuzu standalone-server mode) if this
# becomes a bottleneck.
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/v1/health').read()" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
