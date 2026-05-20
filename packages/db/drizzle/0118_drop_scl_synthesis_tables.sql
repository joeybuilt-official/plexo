-- 0118 — drop SCL + synthesis layer
--
-- SCL (Shared Context Layer), the Louvain clustering pipeline, theme
-- snapshots, kNN edges, and the synthesis-suggestions inbox were retired
-- 2026-05-20 (Sprint A′ Lane 1). Graphiti on FalkorDB is the canonical
-- structure layer; the postgres clustering stack was a parallel build
-- that the audit in adr/0014 and the operator decision recorded in
-- joeybuilt-official/operations/FOUNDATION-EVALUATION.md superseded.
--
-- This migration is intentionally aggressive: drops the tables and their
-- indexes. There is no down-migration. Re-creation would mean re-shipping
-- the clustering code (packages/agent/src/memory/{cluster,suggest,knn,scl,
-- promote,streaming-touch}.ts) which is also deleted in this PR.
--
-- Tables created by:
--   0047_scl_foundation.sql
--   0049_scl_graphs_columns.sql
--   0095_synthesis_alpha.sql
--   0096_themes_hierarchy.sql
--   0097_themes_phase3.sql

DROP TABLE IF EXISTS memory_theme_history CASCADE;
DROP TABLE IF EXISTS memory_knn_edges CASCADE;
DROP TABLE IF EXISTS memory_theme_runs CASCADE;
DROP TABLE IF EXISTS memory_themes CASCADE;
DROP TABLE IF EXISTS synthesis_suggestions CASCADE;
DROP TABLE IF EXISTS scl_concept_graphs CASCADE;
