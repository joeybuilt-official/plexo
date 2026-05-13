-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Add UNIQUE constraint on plexo_ops_errors.fingerprint.
-- Required for ON CONFLICT (fingerprint) upsert in telemetry/router.ts.

DROP INDEX IF EXISTS plexo_ops_errors_fingerprint_idx;
CREATE UNIQUE INDEX plexo_ops_errors_fingerprint_idx ON plexo_ops_errors (fingerprint);
