# Vision model artifacts

This directory holds downloaded ONNX model bundles. **Nothing here is
checked in** — the `.gitignore` excludes `*.onnx`, `*.json`, etc. The
service downloads on first request and verifies SHA-256 before use.

## Expected layout (after first run)

```
models/
├── openclip-vit-b-32/
│   ├── image.onnx          # ViT-B/32 image tower
│   ├── text.onnx           # transformer text tower
│   ├── tokenizer.json
│   └── preprocess.json     # image mean/std/size (matches OpenAI CLIP config)
├── siglip-2/
│   ├── image.onnx
│   ├── text.onnx
│   └── tokenizer.json
├── insightface-buffalo_l/
│   ├── det_10g.onnx        # RetinaFace
│   ├── w600k_r50.onnx      # ArcFace
│   └── (other bundle parts as InsightFace ships them)
└── rapidocr-ppocrv5/
    ├── det.onnx
    ├── cls.onnx
    ├── rec.onnx
    └── dict_en.txt         # one dictionary per supported language
```

## Phase 4.1 status

The SHA-256s and primary CDN paths are intentionally not populated yet —
the model loaders fast-fail with `"model not configured"`. Phase 4.2 will:

1. Pick the exact upstream snapshot for each bundle (HuggingFace revision
   pin / GitHub release tag).
2. Compute SHA-256s.
3. Mirror each artifact to the Joeybuilt CDN bucket and set
   `MODELS_CDN_URL`'s default.
4. Register the artifacts via `registerArtifact()` in each
   `src/models/*.ts` loader.

## Manual cache pre-warm (once artifacts are wired)

```bash
pnpm --filter @plexo/vision download-models
```

Reads every `registerArtifact()` call across the loaders and downloads
into `MODEL_CACHE_DIR` (default `~/.plexo/vision/models`).
