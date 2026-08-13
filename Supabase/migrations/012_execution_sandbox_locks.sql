-- Distributed lease used to serialize external CodeSandbox creation per project.
create table if not exists public.execution_sandbox_locks (
  project_id uuid primary key references public.projects(id) on delete cascade,
  locked_by uuid not null,
  lock_token uuid not null,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.execution_sandbox_locks enable row level security;
revoke all on public.execution_sandbox_locks from anon, authenticated;

drop function if exists public.acquire_execution_sandbox_lock(uuid, uuid, uuid, integer);
create or replace function public.acquire_execution_sandbox_lock(
  p_project_id uuid,
  p_user_id uuid,
  p_lock_token uuid,
  p_stale_after_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  acquired boolean := false;
begin
  if not exists (select 1 from public.projects where id = p_project_id and user_id = p_user_id) then
    raise exception 'Project is not owned by the requested user';
  end if;

  insert into public.execution_sandbox_locks(project_id, locked_by, lock_token, locked_at, expires_at)
  values (p_project_id, p_user_id, p_lock_token, now_ts, now_ts + make_interval(secs => greatest(1, p_stale_after_seconds)))
  on conflict (project_id) do update
    set locked_by = excluded.locked_by,
        lock_token = excluded.lock_token,
        locked_at = excluded.locked_at,
        expires_at = excluded.expires_at
    where public.execution_sandbox_locks.expires_at <= now_ts;

  select true into acquired
  from public.execution_sandbox_locks
  where project_id = p_project_id and lock_token = p_lock_token;

  return jsonb_build_object('acquired', coalesce(acquired, false), 'lock_token', p_lock_token);
end;
$$;

drop function if exists public.release_execution_sandbox_lock(uuid, uuid, uuid);
create or replace function public.release_execution_sandbox_lock(
  p_project_id uuid,
  p_user_id uuid,
  p_lock_token uuid
) returns void
language sql
security definer
set search_path = public
as $$
  delete from public.execution_sandbox_locks
  where project_id = p_project_id and locked_by = p_user_id and lock_token = p_lock_token;
$$;

grant execute on function public.acquire_execution_sandbox_lock(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.release_execution_sandbox_lock(uuid, uuid, uuid) to service_role;
