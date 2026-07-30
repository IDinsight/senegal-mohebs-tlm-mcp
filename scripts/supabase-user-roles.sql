-- ─── #8 Curator / approver roles — Supabase side ────────────────────────────
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor). It:
--   1. Creates `public.user_roles` — the source of truth for who is a
--      curator or approver.
--   2. Locks it down with RLS so only the service role can write.
--   3. Creates a Custom Access Token Hook function that reads the role and
--      adds an `app_role` claim to every issued JWT.
--   4. Grants the hook access to the table.
--
-- After running this: go to Dashboard → Authentication → Hooks → Add a new
-- hook → "Customize Access Token (JWT) Claims" → point it at
-- `public.custom_access_token_hook`. Save. From then on, every token this
-- Supabase project mints carries `app_role: "curator" | "approver" | null`,
-- which the MCP server reads via `resolveActor` (see src/actor.ts).
--
-- Bootstrapping the first approver:
--   -- Look up the user's uid from Authentication → Users, then:
--   insert into public.user_roles (user_id, role) values ('<uid>', 'approver');
--
-- Granting / revoking a role later:
--   Do it in the SQL editor with the service role — the MCP has NO surface
--   for role writes, by design (see the acceptance criteria in the #8 task).
--   Anyone with Supabase admin can grant; no MCP user can self-escalate.

-- ── 1. The table ────────────────────────────────────────────────────────────

create table if not exists public.user_roles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('curator', 'approver')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_roles_role_idx on public.user_roles(role);

-- Timestamp trigger for updated_at.
create or replace function public.user_roles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_roles_updated_at on public.user_roles;
create trigger user_roles_updated_at
  before update on public.user_roles
  for each row execute function public.user_roles_touch_updated_at();

-- ── 2. Lock it down ─────────────────────────────────────────────────────────
-- RLS is enabled. No policies for anon/authenticated → they see nothing and
-- can write nothing. Only the service role (and `supabase_auth_admin`, which
-- we grant below) can read/write. This is deliberate: role management is an
-- admin operation, not a user operation.

alter table public.user_roles enable row level security;

-- Explicitly revoke default grants — belt-and-braces.
revoke all on public.user_roles from anon, authenticated;

-- ── 3. The Custom Access Token Hook function ────────────────────────────────
-- Supabase calls this at token-mint time with an `event` jsonb containing
-- `user_id` and the base `claims`. We look up the user's role and inject
-- `app_role` into the claims. The function is STABLE (deterministic for a
-- given input) — Supabase caches accordingly.
--
-- Note: `app_role` is the exact claim name our server reads (see
-- src/actor.ts::resolveActor). If you rename it here, rename it there too.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims    jsonb;
  user_role text;
begin
  -- Look up the caller's role. Missing row → null → no `app_role` claim on
  -- the token → the MCP treats the user as "signed in but no role" (reads
  -- and generation only). This is the correct default: a fresh signed-up
  -- user should not be able to mutate the graph until an admin grants them
  -- a role.
  select role into user_role
  from public.user_roles
  where user_id = (event->>'user_id')::uuid;

  claims := event->'claims';
  if user_role is not null then
    claims := jsonb_set(claims, '{app_role}', to_jsonb(user_role));
  else
    -- Explicitly set null so the claim is present but empty — the client
    -- can distinguish "no role assigned" from "hook didn't run".
    claims := jsonb_set(claims, '{app_role}', 'null'::jsonb);
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- ── 4. Grant the hook access ────────────────────────────────────────────────
-- The hook runs as `supabase_auth_admin`. It needs execute on the function
-- and select on the table. Nothing else does — anon/authenticated stay
-- locked out entirely.

grant execute on function public.custom_access_token_hook(jsonb)
  to supabase_auth_admin;

grant select on public.user_roles
  to supabase_auth_admin;

-- Prevent the hook function from being called by anyone else — belt-and-
-- braces. It's harmless (no side effects), but keeping the surface minimal
-- avoids surprises.
revoke execute on function public.custom_access_token_hook(jsonb)
  from public, anon, authenticated;
