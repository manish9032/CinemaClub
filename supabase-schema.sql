-- CinemaClub Supabase schema and security policies.
-- Existing rooms with legacy SHA-256 hashes are migrated to a private table and
-- upgraded to bcrypt on the first successful join. New room passwords are bcrypt-hashed server-side.

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id text primary key,
  password_hash text not null,
  host_id uuid not null references auth.users(id) on delete cascade,
  host_name text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  movie_id integer,
  movie_title text,
  movie_poster text,
  is_playing boolean not null default false,
  "current_time" double precision not null default 0 check ("current_time" >= 0),
  last_sync_at timestamptz not null default now(),
  video_src_type text check (video_src_type is null or video_src_type in ('stream', 'local', 'youtube')),
  video_src text,
  local_file_name text,
  constraint one_room_per_host unique (host_id)
);

-- Password hashes live outside the Realtime-published rooms table so they
-- cannot leak in row-change payloads. Migrate legacy SHA-256 hashes privately,
-- then drop the public-table column.
create table if not exists public.room_passwords (
  room_id text primary key references public.rooms(id) on delete cascade,
  password_hash text not null,
  password_scheme text not null default 'bcrypt' check (password_scheme in ('bcrypt', 'legacy_sha256'))
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'rooms' and column_name = 'password_hash'
  ) then
    execute $migration$
      insert into public.room_passwords (room_id, password_hash, password_scheme)
      select id, password_hash,
             case when password_hash ~ '^[0-9a-f]{64}$' then 'legacy_sha256' else 'bcrypt' end
      from public.rooms
      on conflict (room_id) do nothing
    $migration$;
    alter table public.rooms drop column password_hash;
  end if;
end $$;
alter table public.room_passwords enable row level security;
revoke all on public.room_passwords from public, anon, authenticated;

create table if not exists public.room_participants (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 20),
  is_host boolean not null default false,
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  constraint unique_participant unique (room_id, user_id)
);

create table if not exists public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.rooms(id) on delete cascade,
  participant_id uuid,
  participant_name text not null,
  text text not null check (char_length(text) between 1 and 1000),
  type text not null default 'message' check (type in ('message', 'system')),
  created_at timestamptz not null default now()
);

create index if not exists idx_rooms_host on public.rooms(host_id);
create index if not exists idx_rooms_expires on public.rooms(expires_at);
create index if not exists idx_participants_room on public.room_participants(room_id);
create index if not exists idx_messages_room on public.room_messages(room_id, created_at);

alter table public.rooms enable row level security;
alter table public.room_participants enable row level security;
alter table public.room_messages enable row level security;

-- SECURITY DEFINER helper avoids recursive participant-table RLS evaluation.
create or replace function public.is_room_member(p_room_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.room_participants p
    where p.room_id = upper(p_room_id)
      and p.user_id = auth.uid()
      and p.is_active = true
  );
$$;
revoke all on function public.is_room_member(text) from public;
grant execute on function public.is_room_member(text) to authenticated;

-- Remove the previous permissive policies before creating the restrictive ones.
drop policy if exists "Anyone authenticated can read rooms" on public.rooms;
drop policy if exists "Authenticated users can create rooms" on public.rooms;
drop policy if exists "Host can update own room" on public.rooms;
drop policy if exists "Host can delete own room" on public.rooms;
drop policy if exists "Room members can read rooms" on public.rooms;
drop policy if exists "Host can update own room safely" on public.rooms;
drop policy if exists "Host can delete own room safely" on public.rooms;

create policy "Room members can read rooms"
  on public.rooms for select to authenticated
  using (public.is_room_member(id));

create policy "Host can update own room safely"
  on public.rooms for update to authenticated
  using (auth.uid() = host_id)
  with check (auth.uid() = host_id);

create policy "Host can delete own room safely"
  on public.rooms for delete to authenticated
  using (auth.uid() = host_id);

-- Hide the password hash at the SQL privilege layer as well as via RLS.
revoke select on public.rooms from public, anon, authenticated;
grant select (
  id, host_id, host_name, created_at, expires_at, movie_id, movie_title,
  movie_poster, is_playing, "current_time", last_sync_at, video_src_type,
  video_src, local_file_name
) on public.rooms to authenticated;
grant update (is_playing, "current_time", last_sync_at, video_src_type, video_src, local_file_name)
  on public.rooms to authenticated;
revoke insert on public.rooms from anon, authenticated;

-- Participant rows are created only by the password-checking SECURITY DEFINER RPC.
drop policy if exists "Anyone authenticated can read participants" on public.room_participants;
drop policy if exists "Users can insert themselves as participants" on public.room_participants;
drop policy if exists "Users can update own participant row" on public.room_participants;
drop policy if exists "Users can delete own participant row" on public.room_participants;
drop policy if exists "Room members can read participants" on public.room_participants;
drop policy if exists "Users can update their own membership" on public.room_participants;

create policy "Room members can read participants"
  on public.room_participants for select to authenticated
  using (public.is_room_member(room_id) or user_id = auth.uid());

create policy "Users can update their own membership"
  on public.room_participants for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and is_host = exists (
      select 1 from public.rooms r where r.id = room_id and r.host_id = auth.uid()
    )
  );
revoke insert, delete on public.room_participants from anon, authenticated;
grant update (name, is_active) on public.room_participants to authenticated;

-- Only members can read chat; clients can only send ordinary messages as themselves.
drop policy if exists "Anyone authenticated can read messages" on public.room_messages;
drop policy if exists "Authenticated users can insert messages" on public.room_messages;
drop policy if exists "Room members can read messages" on public.room_messages;
drop policy if exists "Members can send their own chat messages" on public.room_messages;

create policy "Room members can read messages"
  on public.room_messages for select to authenticated
  using (public.is_room_member(room_id));

create policy "Members can send their own chat messages"
  on public.room_messages for insert to authenticated
  with check (
    type = 'message'
    and participant_id = auth.uid()
    and char_length(trim(text)) between 1 and 1000
    and exists (
      select 1 from public.room_participants p
      where p.room_id = room_messages.room_id
        and p.user_id = auth.uid()
        and p.is_active = true
        and p.name = room_messages.participant_name
    )
  );
revoke update, delete on public.room_messages from anon, authenticated;
grant insert (room_id, participant_id, participant_name, text, type) on public.room_messages to authenticated;

-- Create a room atomically. Passwords are salted and hashed on the database,
-- not in browser JavaScript. The returned JSON never contains password_hash.
create or replace function public.create_room(
  p_room_id text,
  p_password text,
  p_host_name text,
  p_movie_id integer default null,
  p_movie_title text default null,
  p_movie_poster text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_name text := trim(p_host_name);
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_password is null or length(p_password) < 8 or octet_length(p_password) > 72 then raise exception 'Room password must be 8-72 characters'; end if;
  if p_room_id !~ '^[A-HJ-NP-Z2-9]{6}$' then raise exception 'Invalid room code'; end if;
  if length(v_name) < 2 or length(v_name) > 20 then raise exception 'Display name must be 2-20 characters'; end if;

  delete from public.rooms where host_id = v_uid and expires_at <= now();

  insert into public.rooms (
    id, host_id, host_name, expires_at,
    movie_id, movie_title, movie_poster
  ) values (
    upper(p_room_id), v_uid, v_name,
    now() + interval '48 hours', p_movie_id, p_movie_title, p_movie_poster
  ) returning * into v_room;

  insert into public.room_passwords (room_id, password_hash, password_scheme)
  values (v_room.id, crypt(p_password, gen_salt('bf', 12)), 'bcrypt');

  insert into public.room_participants (room_id, user_id, name, is_host, is_active)
  values (v_room.id, v_uid, v_name, true, true);

  insert into public.room_messages (room_id, participant_id, participant_name, text, type)
  values (v_room.id, null, 'System', v_name || ' created the room', 'system');

  return to_jsonb(v_room);
exception when unique_violation then
  raise exception 'You already have an active room or the room code collided. Try again.';
end;
$$;

-- Verify the password server-side, then create/reactivate membership atomically.
create or replace function public.join_room_with_password(
  p_room_id text,
  p_password text,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_password_hash text;
  v_password_scheme text;
  v_name text := trim(p_display_name);
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_password is null or length(p_password) < 8 or octet_length(p_password) > 72 then raise exception 'Invalid room password'; end if;
  if length(v_name) < 2 or length(v_name) > 20 then raise exception 'Display name must be 2-20 characters'; end if;

  select * into v_room
  from public.rooms
  where id = upper(p_room_id) and expires_at > now();

  if not found then
    raise exception 'Room not found, expired, or password is incorrect';
  end if;

  select password_hash, password_scheme
    into v_password_hash, v_password_scheme
  from public.room_passwords where room_id = v_room.id;

  if v_password_hash is null then
    raise exception 'Room not found, expired, or password is incorrect';
  elsif v_password_scheme = 'legacy_sha256' then
    if encode(digest(p_password, 'sha256'), 'hex') <> v_password_hash then
      raise exception 'Room not found, expired, or password is incorrect';
    end if;
    -- Upgrade a legacy room hash after a successful password check.
    update public.room_passwords
      set password_hash = crypt(p_password, gen_salt('bf', 12)), password_scheme = 'bcrypt'
      where room_id = v_room.id;
  elsif crypt(p_password, v_password_hash) <> v_password_hash then
    raise exception 'Room not found, expired, or password is incorrect';
  end if;

  insert into public.room_participants (room_id, user_id, name, is_host, is_active)
  values (v_room.id, v_uid, v_name, v_room.host_id = v_uid, true)
  on conflict (room_id, user_id) do update
    set name = excluded.name, is_active = true;

  insert into public.room_messages (room_id, participant_id, participant_name, text, type)
  values (v_room.id, null, 'System', v_name || ' joined the room', 'system');

  return to_jsonb(v_room);
end;
$$;

-- Any active room member may play, pause, or seek. Only the room row's playback
-- fields are changed; source changes and room deletion remain host-only.
create or replace function public.sync_room_playback(
  p_room_id text,
  p_is_playing boolean,
  p_current_time double precision
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_room_member(p_room_id) then
    raise exception 'Room membership required';
  end if;
  if p_current_time is null or p_current_time < 0 or p_current_time > 604800 then
    raise exception 'Invalid playback position';
  end if;

  update public.rooms
  set is_playing = p_is_playing,
      "current_time" = p_current_time,
      last_sync_at = now()
  where id = upper(p_room_id) and expires_at > now();
  if not found then raise exception 'Room not found or expired'; end if;
end;
$$;

revoke all on function public.create_room(text, text, text, integer, text, text) from public;
revoke all on function public.join_room_with_password(text, text, text) from public;
revoke all on function public.sync_room_playback(text, boolean, double precision) from public;
grant execute on function public.create_room(text, text, text, integer, text, text) to authenticated;
grant execute on function public.join_room_with_password(text, text, text) to authenticated;
grant execute on function public.sync_room_playback(text, boolean, double precision) to authenticated;

-- Realtime subscriptions are filtered by RLS and room membership.
do $$
begin
  begin alter publication supabase_realtime add table public.rooms; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.room_participants; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.room_messages; exception when duplicate_object then null; end;
end $$;

-- Verify after applying: inspect policies and test with two authenticated accounts.

-- Optional: if rooms table already exists without youtube in the check constraint:
-- alter table public.rooms drop constraint if exists rooms_video_src_type_check;
-- alter table public.rooms add constraint rooms_video_src_type_check
--   check (video_src_type is null or video_src_type in ('stream', 'local', 'youtube'));
