-- Distributed executor rate limiting for serverless deployments.
-- The API route uses this atomic RPC when SUPABASE_SERVICE_ROLE_KEY is configured.
-- It prevents Vercel instances from each maintaining an independent in-memory quota.

create table if not exists public.execution_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0,
  concurrent_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.execution_rate_limits enable row level security;

revoke all on public.execution_rate_limits from anon, authenticated;

drop function if exists public.acquire_execution_rate_limit(uuid, integer, integer, integer);
create or replace function public.acquire_execution_rate_limit(
  p_user_id uuid,
  p_window_seconds integer,
  p_max_requests integer,
  p_max_concurrent integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data public.execution_rate_limits;
  now_ts timestamptz := now();
  next_reset timestamptz;
begin
  insert into public.execution_rate_limits(user_id, window_started_at, request_count, concurrent_count, updated_at)
  values (p_user_id, now_ts, 0, 0, now_ts)
  on conflict (user_id) do nothing;

  select * into row_data
  from public.execution_rate_limits
  where user_id = p_user_id
  for update;

  if extract(epoch from (now_ts - row_data.window_started_at)) >= p_window_seconds then
    update public.execution_rate_limits
      set window_started_at = now_ts,
          request_count = 0,
          concurrent_count = 0,
          updated_at = now_ts
      where user_id = p_user_id
      returning * into row_data;
  end if;

  next_reset := row_data.window_started_at + make_interval(secs => p_window_seconds);

  if row_data.request_count >= p_max_requests then
    return jsonb_build_object('allowed', false, 'reason', 'requests', 'retry_after', greatest(1, ceil(extract(epoch from (next_reset - now_ts))))::integer, 'concurrent_count', row_data.concurrent_count);
  end if;

  if row_data.concurrent_count >= p_max_concurrent then
    return jsonb_build_object('allowed', false, 'reason', 'concurrency', 'retry_after', 1, 'concurrent_count', row_data.concurrent_count);
  end if;

  update public.execution_rate_limits
    set request_count = request_count + 1,
        concurrent_count = concurrent_count + 1,
        updated_at = now_ts
    where user_id = p_user_id
    returning * into row_data;

  return jsonb_build_object('allowed', true, 'retry_after', 0, 'concurrent_count', row_data.concurrent_count, 'request_count', row_data.request_count);
end;
$$;

drop function if exists public.release_execution_rate_limit(uuid);
create or replace function public.release_execution_rate_limit(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.execution_rate_limits
  set concurrent_count = greatest(0, concurrent_count - 1),
      updated_at = now()
  where user_id = p_user_id;
$$;

grant execute on function public.acquire_execution_rate_limit(uuid, integer, integer, integer) to service_role;
grant execute on function public.release_execution_rate_limit(uuid) to service_role;
