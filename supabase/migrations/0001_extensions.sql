-- 0001_extensions.sql
-- Enable the Postgres extensions the PMO Control Tower depends on.
-- pg_cron + pg_net power the escalation engine and the weekly-update-cycle scheduler
-- (CLAUDE.md §8 scheduled jobs, §11 escalation engine). pgcrypto/uuid-ossp are already present.
create extension if not exists pg_cron;
create extension if not exists pg_net;
