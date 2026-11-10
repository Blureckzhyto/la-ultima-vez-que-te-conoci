-- Ejecuta este archivo completo en Supabase: SQL Editor > New query > Run.
-- Las políticas RLS limitan los cambios privados a la cuenta autenticada.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);

create or replace function public.create_reader_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_reader_profile on auth.users;
create trigger on_auth_user_created_reader_profile
  after insert on auth.users
  for each row execute function public.create_reader_profile();

create table if not exists public.reading_progress (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  page_start integer not null default 1 check (page_start between 1 and 1000),
  updated_at timestamptz not null default now()
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade default auth.uid(),
  chapter_number integer not null check (chapter_number between 1 and 1000),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists comments_chapter_created on public.comments (chapter_number, created_at desc);

alter table public.profiles enable row level security;
alter table public.reading_progress enable row level security;
alter table public.comments enable row level security;

drop policy if exists "Reader names are public" on public.profiles;
create policy "Reader names are public" on public.profiles
  for select to anon, authenticated using (true);

drop policy if exists "Readers can read their own progress" on public.reading_progress;
create policy "Readers can read their own progress" on public.reading_progress
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Readers can create their own progress" on public.reading_progress;
create policy "Readers can create their own progress" on public.reading_progress
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Readers can update their own progress" on public.reading_progress;
create policy "Readers can update their own progress" on public.reading_progress
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Comments are public" on public.comments;
create policy "Comments are public" on public.comments
  for select to anon, authenticated using (true);
drop policy if exists "Readers can comment as themselves" on public.comments;
create policy "Readers can comment as themselves" on public.comments
  for insert to authenticated with check ((select auth.uid()) = author_id);

grant select on public.profiles to anon, authenticated;
grant select, insert, update on public.reading_progress to authenticated;
grant select on public.comments to anon, authenticated;
grant insert on public.comments to authenticated;
