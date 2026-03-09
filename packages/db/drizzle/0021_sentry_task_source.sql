-- 0021: add 'sentry' to task_source enum
-- Postgres ALTER TYPE ADD VALUE is non-transactional; we guard with IF NOT EXISTS.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'sentry'
          AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'task_source')
    ) THEN
        ALTER TYPE task_source ADD VALUE 'sentry';
    END IF;
END
$$;
