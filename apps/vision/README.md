# @plexo/vision

Self-hosted vision service for Plexo — CLIP image/text embeddings, face
detection + ArcFace embeddings, and OCR. Runs everything on
[ONNX Runtime Node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
so there is no Python sidecar to ship or maintain.

See [ADR 0001 — ML in Plexo / vision via ONNX](../../../fonto/docs/adr/0001-ml-in-plexo-vision-onnx.md)
for the architectural decision.

## Status: Phase 4.1 bootstrap

This commit ships the route surface, auth, telemetry, and model registry
plumbing. The actual `.onnx` weights and their SHA-256s are wired in Phase
4.2 — until then every inference route returns `503 model_unavailable`
with `"… not configured"`. Health, `/vision/models`, and the OpenAPI shape
are stable and safe to integrate against now.

## Models

| Model                       | Task            | Output dim | Default? |
|----------------------------|-----------------|------------|----------|
| `openclip-vit-b-32`        | CLIP image+text | 512        | yes      |
| `siglip-2`                 | CLIP image+text | 512        | opt-in   |
| `insightface-buffalo_l`    | RetinaFace + ArcFace | 512  | yes (only choice) |
| `rapidocr-ppocrv5`         | OCR detect+rec  | n/a        | yes (only choice) |

Same vector spaces Fonto / Immich use, which keeps cross-service embedding
comparisons cheap.

## Environment

| Var                            | Required | Default                              | Notes |
|--------------------------------|----------|--------------------------------------|-------|
| `PLEXO_SERVICE_KEY`            | yes      | —                                    | Bearer token apps/api uses to call the service. |
| `PORT`                         | no       | `7000`                               | |
| `MODEL_CACHE_DIR`              | no       | `~/.plexo/vision/models`             | Where ONNX weights are stored after download. |
| `MODELS_CDN_URL`               | no       | (upstream HuggingFace / GitHub)      | Joeybuilt-hosted mirror. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | no       | —                                    | Emits `plexo_vision_inference_duration_seconds` histogram. |
| `OTEL_SERVICE_NAME`            | no       | `plexo-vision`                       | |
| `LOG_LEVEL`                    | no       | `info`                               | pino level. |

## Routes

All `/vision/clip/*`, `/vision/faces/*`, and `/vision/ocr` routes require
`Authorization: Bearer ${PLEXO_SERVICE_KEY}`. `/vision/health` and
`/vision/models` are unauthenticated (used by docker healthchecks and the
first-run wizard, same pattern as `apps/embeddings`).

### `POST /vision/clip/image`

```json
{ "image": "<base64 or data:image URL>", "modelId": "openclip-vit-b-32" }
→
{ "vector": [/* 512 floats */], "modelId": "openclip-vit-b-32", "computedAt": "..." }
```

### `POST /vision/clip/text`

```json
{ "text": "a photo of a forklift", "modelId": "openclip-vit-b-32" }
→
{ "vector": [/* 512 floats */], "modelId": "openclip-vit-b-32", "computedAt": "..." }
```

### `POST /vision/faces/detect`

```json
{ "image": "<base64>" }
→
{
  "faces": [
    {
      "bbox": [x, y, w, h],
      "confidence": 0.99,
      "landmarks": [[x,y],[x,y],[x,y],[x,y],[x,y]]
    }
  ],
  "modelId": "insightface-buffalo_l",
  "computedAt": "..."
}
```

### `POST /vision/faces/embed`

```json
{ "image": "<base64>", "bbox": [10, 20, 100, 100] }
→
{ "vector": [/* 512 floats */], "modelId": "insightface-buffalo_l", "computedAt": "..." }
```

If `bbox` is omitted, the service runs detect first and embeds the largest face.

### `POST /vision/ocr`

```json
{ "image": "<base64>", "lang": "en" }
→
{
  "lines": [
    { "text": "INVOICE", "bbox": [x,y,w,h], "confidence": 0.97 }
  ],
  "modelId": "rapidocr-ppocrv5",
  "computedAt": "..."
}
```

### `GET /vision/health`

```json
{ "ok": true, "models": { "clip": { ... }, "faces": { ... }, "ocr": { ... } } }
```

### `GET /vision/models`

Lists every registered model id + load status + recent inference latency
percentiles (per task).

## Local dev

```bash
pnpm --filter @plexo/vision install
PLEXO_SERVICE_KEY=dev pnpm --filter @plexo/vision dev
```

```bash
# Quick smoke test (will return 503 until models are wired in Phase 4.2)
curl -s http://127.0.0.1:7000/vision/health | jq

curl -s -X POST http://127.0.0.1:7000/vision/clip/text \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello"}' | jq
```

## Who calls this

Fonto's photo pipeline calls `/vision/clip/image` per uploaded asset, then
periodically calls `/vision/faces/detect` + `/vision/faces/embed` for the
face-clustering job, and `/vision/ocr` for text-bearing assets (receipts,
screenshots). Plexo's apps/api also re-exports these endpoints via the
existing service-key proxy so other workspace apps don't need direct
network access.

## Container

```bash
docker build -f docker/Dockerfile.vision -t plexo-vision .
docker run --rm -p 7000:7000 -e PLEXO_SERVICE_KEY=dev plexo-vision
```

Compose profile: `vision` (gated like `local-embeddings` so the heavy
service is off by default).
