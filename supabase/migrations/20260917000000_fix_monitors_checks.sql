-- Repair + harden the monitors CHECK constraints.
--
-- Context: the original create_monitors_tables migration allowed intervals
-- (10, 15, 20, 30, 45, 60) while shared/schemas.ts ALLOWED_INTERVALS allows
-- (10, 14, 15, 20, 30, 45, 60). The 20260904090000 migration tried to close
-- that gap with fragile catalog probing (ILIKE on the constraint definition
-- plus a "%14%" substring test). Any database that missed that migration
-- rejects interval 14 with 23514 (monitors_interval_minutes_check) even
-- though the API validation passes.
--
-- This migration is deterministic and idempotent: it drops the canonical
-- constraint names if present and re-adds the exact allow-lists that match
-- shared/schemas.ts, so the final state is correct regardless of which
-- earlier migrations have run. It runs in a single transaction, so there is
-- no window where concurrent inserts can slip in unchecked rows.
--
-- It also adds monitors_timeout_lt_interval_check (timeout must be strictly
-- below the check interval). Every currently allowed combination satisfies it
-- (max timeout 60s < min interval 10min = 600s), so existing rows are safe.

-- 1. Canonical interval allow-list (matches ALLOWED_INTERVALS).
alter table public.monitors drop constraint if exists monitors_interval_minutes_check;
alter table public.monitors
  add constraint monitors_interval_minutes_check
  check (interval_minutes in (10, 14, 15, 20, 30, 45, 60));

-- 2. Canonical timeout allow-list (matches ALLOWED_TIMEOUTS).
alter table public.monitors drop constraint if exists monitors_timeout_seconds_check;
alter table public.monitors
  add constraint monitors_timeout_seconds_check
  check (timeout_seconds in (1, 5, 10, 15, 20, 30, 45, 60));

-- 3. Timeout must be strictly below the check interval.
alter table public.monitors drop constraint if exists monitors_timeout_lt_interval_check;
alter table public.monitors
  add constraint monitors_timeout_lt_interval_check
  check (timeout_seconds < interval_minutes * 60);

-- 4. Harden the per-minute scheduler: skip pgmq.send_batch when nothing is
-- due. An empty batch is wasted work (and errors on some pgmq versions),
-- which would otherwise fire every idle minute.
create or replace function public.enqueue_due_monitors()
returns void
language plpgsql
as $$
declare
  v_msgs jsonb[];
begin
  select coalesce(array_agg(jsonb_build_object('monitor_id', id) order by next_check_at asc), '{}'::jsonb[])
    into v_msgs
    from (
      select id, next_check_at
      from public.monitors
      where is_paused = false
        and next_check_at <= now()
      order by next_check_at asc
      limit 500
    ) due;

  if array_length(v_msgs, 1) > 0 then
    perform pgmq.send_batch('monitor_checks', v_msgs);
  end if;
end;
$$;
