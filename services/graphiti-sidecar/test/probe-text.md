# Phase 11 canonical probe text

The smoke + Phase 11 schema-compat probe both feed graphiti the same
text so a regression caused by graphiti-core / FalkorDB version drift is
distinguishable from LLM-quality drift.

> **What the CI probe actually asserts.** `probe.sh` runs against
> `probe-stub.py`, which answers every model call with schema-shaped
> constants — it never reads the episode text. So the entities below are
> what a *real* model produces from this text (the prod smoke path), not
> what the CI probe sees; the probe asserts the pipeline's structure
> instead: an `episode_id` comes back, nodes land in FalkorDB, and
> `/v1/search` returns 200 with ≥1 edge for a hyphenated-UUID
> `group_id`. Keep the text realistic anyway: the moment a probe run has
> a real model behind it, the table below is the expectation.

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
  point at infra (FalkorDB, sidecar, schema), not model quality.

If a future bump's probe fails on this text, the failure is structural,
not model-quality.
