-- Add 'awaiting_approval' to task_status enum (Phase D approval gate)
ALTER TYPE "task_status" ADD VALUE IF NOT EXISTS 'awaiting_approval';
