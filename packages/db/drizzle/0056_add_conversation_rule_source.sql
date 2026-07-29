-- SPDX-License-Identifier: MIT
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Add 'conversation' to the rule_source enum.
-- Phase 3.5 (conversation-bridge) writes behavior_rules with source='conversation'
-- but the enum value was never added. Lightweight — no data backfill.

ALTER TYPE "rule_source" ADD VALUE IF NOT EXISTS 'conversation';
