-- Link existing Riiroow staff records to Supabase Auth identities.
-- Additive only: does not delete, recreate, or alter existing staff credentials.
-- This file is prepared for review and is NOT applied to the production database.

alter table public.users
  add column if not exists auth_user_id uuid,
  add column if not exists must_change_password boolean not null default true,
  add column if not exists auth_migrated_at timestamptz;

create unique index if not exists users_auth_user_id_unique
  on public.users (auth_user_id)
  where auth_user_id is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_auth_user_id_fkey'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_auth_user_id_fkey
      foreign key (auth_user_id)
      references auth.users (id)
      on delete set null;
  end if;
end
$$;

comment on column public.users.auth_user_id is
  'Supabase Auth identity linked to this existing Riiroow staff record.';
comment on column public.users.must_change_password is
  'When true, staff must replace their provisioned initial password before using the dashboard.';
comment on column public.users.auth_migrated_at is
  'Timestamp when this staff record was linked to Supabase Auth.';
