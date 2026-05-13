CREATE INDEX IF NOT EXISTS "work_ledger_task_idx"
    ON "work_ledger" ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_ledger_type_idx"
    ON "work_ledger" ("type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rsi_test_results_task_idx"
    ON "rsi_test_results" ("task_id");
