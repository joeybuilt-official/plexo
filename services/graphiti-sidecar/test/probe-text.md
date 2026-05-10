# Phase 11 canonical probe text

The smoke + Phase 11 schema-compat probe both feed graphiti the same
text so a regression caused by graphiti-core / Kuzu version drift is
distinguishable from LLM-quality drift.

## The text

```
Phase 3c smoke marker — <ISO-8601 timestamp>.
Alice manages Bob.
Bob reports to Alice.
Alice works at Acme.
Acme is headquartered in Austin.
Bob lives in Austin.
```

## What graphiti should extract

| Type | Items |
|---|---|
| Entities (≥4) | Alice, Bob, Acme, Austin |
| Edges (≥3) | Alice—manages→Bob, Bob—reports_to→Alice, Acme—headquartered_in→Austin (or Bob—lives_in→Austin) |
| FTS hits on `Austin` | ≥2 (the headquarters fact + the lives-in fact) |

## Pass condition

`addEpisode` returns `episode_id` AND `search("Austin")` returns ≥1 result.

≥1 (not exact-N) because graphiti's dedup pass varies across versions
— a future bump that collapses two Austin-edges into one shouldn't
fail the probe.

## Why these triples

- **Five sentences**: above the "1-sentence-no-edges" threshold observed
  on gpt-oss:120b (smoke text "Plexo prefers Kuzu" extracted 0 facts).
- **Two-hop relationships** (Alice↔Bob via manages/reports): forces
  graphiti's edge-resolution dedup path.
- **Shared object** (Austin appears in 2 edges): exercises FTS index +
  RRF ranking.
- **No jargon**: any reasonable LLM should extract these — failures
  point at infra (Kuzu, sidecar, schema), not model quality.

If a future bump's probe fails on this text, the failure is structural,
not model-quality.
