-- =====================================================================
-- 오프닝 법정 : Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여 넣고 Run.
-- 다시 실행해도 안전하도록 if not exists / or replace 로 작성됨.
-- 실행 순서: 01_schema.sql → 02_seed.sql → (C++ 배치 결과) ai_scores.sql
-- =====================================================================

-- ---------- 설정 (초대 코드) : 클라이언트는 직접 못 읽음 ----------
create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);
insert into public.app_settings (key, value) values ('invite_code', 'CHESS-2026')
  on conflict (key) do nothing;
alter table public.app_settings enable row level security;
-- 정책 없음 = anon/authenticated 모두 접근 불가. 아래 security definer 함수로만 사용.

-- ---------- 사용자 프로필 ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  nickname   text not null check (char_length(nickname) between 2 and 16),
  role       text not null default 'user' check (role in ('user', 'admin')),
  banned     boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_nickname_key on public.profiles (lower(nickname));

-- ---------- 분야, 오프닝 ----------
create table if not exists public.categories (
  id          text primary key,
  name        text not null,
  description text not null default '',
  weight      double precision not null default 0 check (weight >= 0),
  ai          boolean not null default true,
  sort        int not null default 0
);

create table if not exists public.openings (
  id         serial primary key,
  slug       text not null unique,
  name       text not null,
  grp        text not null check (grp in ('main', 'sicilian', 'variation', 'unofficial')),
  side       text not null check (side in ('w', 'b')),
  san        text[] not null,
  uci        text[] not null,
  fens       text[] not null,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- 투표 : (사용자, 오프닝, 분야) 당 1표 ----------
create table if not exists public.votes (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  opening_id  int  not null references public.openings (id) on delete cascade,
  category_id text not null references public.categories (id) on delete cascade,
  tier        smallint not null check (tier between 1 and 11),
  updated_at  timestamptz not null default now(),
  primary key (user_id, opening_id, category_id)
);
create index if not exists votes_opening_idx on public.votes (opening_id, category_id);

-- ---------- AI 점수 (C++ 배치가 채움). category_id = 분야 id 또는 'overall' ----------
create table if not exists public.ai_scores (
  opening_id  int  not null references public.openings (id) on delete cascade,
  category_id text not null,
  raw         double precision,
  z           double precision,
  score       double precision not null check (score between 0 and 100),
  se          double precision,
  computed_at timestamptz not null default now(),
  primary key (opening_id, category_id)
);

-- ---------- 게시판 ----------
create table if not exists public.posts (
  id         bigserial primary key,
  author     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  opening_id int references public.openings (id) on delete set null,
  title      text not null check (char_length(title) between 1 and 80),
  body       text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  deleted    boolean not null default false
);
create index if not exists posts_opening_idx on public.posts (opening_id, created_at desc);

create table if not exists public.comments (
  id         bigserial primary key,
  post_id    bigint not null references public.posts (id) on delete cascade,
  author     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  deleted    boolean not null default false
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);

create table if not exists public.likes (
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  target_type text not null check (target_type in ('post', 'comment')),
  target_id   bigint not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, target_type, target_id)
);
create index if not exists likes_target_idx on public.likes (target_type, target_id);

create table if not exists public.reports (
  id          bigserial primary key,
  reporter    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  target_type text not null check (target_type in ('post', 'comment')),
  target_id   bigint not null,
  reason      text not null check (char_length(reason) between 1 and 300),
  created_at  timestamptz not null default now(),
  resolved    boolean not null default false
);

-- =====================================================================
-- 함수
-- =====================================================================

-- 티어 번호(1=안 두면 직무유기 … 11=인류의 수치) → 구간 중앙 점수
create or replace function public.tier_mid(t smallint)
returns double precision language sql immutable as $$
  select case t
    when 1 then 98.5 when 2 then 94.5 when 3 then 88.5 when 4 then 80
    when 5 then 70   when 6 then 60   when 7 then 50   when 8 then 40
    when 9 then 30   when 10 then 18.5 when 11 then 6 end::double precision
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and not banned);
$$;

-- 가입 전 확인용 (가입 화면에서 친절한 오류 메시지를 띄우기 위함)
create or replace function public.check_invite(code text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.app_settings where key = 'invite_code') = trim(code), false);
$$;

create or replace function public.nickname_available(nick text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where lower(nickname) = lower(trim(nick)));
$$;

create or replace function public.get_invite_code()
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  return (select value from public.app_settings where key = 'invite_code');
end $$;

create or replace function public.set_invite_code(code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_ADMIN'; end if;
  if char_length(trim(code)) < 4 then raise exception 'CODE_TOO_SHORT'; end if;
  update public.app_settings set value = trim(code) where key = 'invite_code';
end $$;

-- 가입 시 서버에서 초대 코드 검사 + 프로필 생성. 첫 가입자는 자동으로 관리자.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  code text;
  nick text := trim(coalesce(new.raw_user_meta_data ->> 'nickname', ''));
begin
  select value into code from public.app_settings where key = 'invite_code';
  if code is null or trim(coalesce(new.raw_user_meta_data ->> 'invite', '')) <> code then
    raise exception 'INVALID_INVITE';
  end if;
  if char_length(nick) < 2 or char_length(nick) > 16 then
    raise exception 'INVALID_NICKNAME';
  end if;
  insert into public.profiles (id, nickname, role)
  values (new.id, nick, case when exists (select 1 from public.profiles) then 'user' else 'admin' end);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 투표 시각 자동 갱신
create or replace function public.touch_vote()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists votes_touch on public.votes;
create trigger votes_touch before update on public.votes
  for each row execute function public.touch_vote();

grant execute on function public.check_invite(text) to anon, authenticated;
grant execute on function public.nickname_available(text) to anon, authenticated;
grant execute on function public.get_invite_code() to authenticated;
grant execute on function public.set_invite_code(text) to authenticated;

-- =====================================================================
-- 행 단위 권한 (RLS) : 읽기는 가입자 전체, 쓰기는 자기 것만 (관리자 예외)
-- =====================================================================
alter table public.profiles   enable row level security;
alter table public.categories enable row level security;
alter table public.openings   enable row level security;
alter table public.votes      enable row level security;
alter table public.ai_scores  enable row level security;
alter table public.posts      enable row level security;
alter table public.comments   enable row level security;
alter table public.likes      enable row level security;
alter table public.reports    enable row level security;

drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_admin on public.profiles;
create policy profiles_read  on public.profiles for select to authenticated using (true);
create policy profiles_admin on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists categories_read  on public.categories;
drop policy if exists categories_admin on public.categories;
create policy categories_read  on public.categories for select to authenticated using (true);
create policy categories_admin on public.categories for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists openings_read  on public.openings;
drop policy if exists openings_admin on public.openings;
create policy openings_read  on public.openings for select to authenticated using (true);
create policy openings_admin on public.openings for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists ai_read  on public.ai_scores;
drop policy if exists ai_admin on public.ai_scores;
create policy ai_read  on public.ai_scores for select to authenticated using (true);
create policy ai_admin on public.ai_scores for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists votes_read   on public.votes;
drop policy if exists votes_insert on public.votes;
drop policy if exists votes_update on public.votes;
drop policy if exists votes_delete on public.votes;
create policy votes_read   on public.votes for select to authenticated using (true);
create policy votes_insert on public.votes for insert to authenticated with check (user_id = auth.uid() and public.is_active());
create policy votes_update on public.votes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_active());
create policy votes_delete on public.votes for delete to authenticated using (user_id = auth.uid());

drop policy if exists posts_read   on public.posts;
drop policy if exists posts_insert on public.posts;
drop policy if exists posts_update on public.posts;
create policy posts_read   on public.posts for select to authenticated using (not deleted or public.is_admin());
create policy posts_insert on public.posts for insert to authenticated with check (author = auth.uid() and public.is_active() and not deleted);
create policy posts_update on public.posts for update to authenticated
  using (author = auth.uid() or public.is_admin())
  with check (author = auth.uid() or public.is_admin());

drop policy if exists comments_read   on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_update on public.comments;
create policy comments_read   on public.comments for select to authenticated using (not deleted or public.is_admin());
create policy comments_insert on public.comments for insert to authenticated with check (author = auth.uid() and public.is_active() and not deleted);
create policy comments_update on public.comments for update to authenticated
  using (author = auth.uid() or public.is_admin())
  with check (author = auth.uid() or public.is_admin());

drop policy if exists likes_read   on public.likes;
drop policy if exists likes_insert on public.likes;
drop policy if exists likes_delete on public.likes;
create policy likes_read   on public.likes for select to authenticated using (true);
create policy likes_insert on public.likes for insert to authenticated with check (user_id = auth.uid() and public.is_active());
create policy likes_delete on public.likes for delete to authenticated using (user_id = auth.uid());

drop policy if exists reports_insert on public.reports;
drop policy if exists reports_admin  on public.reports;
drop policy if exists reports_update on public.reports;
create policy reports_insert on public.reports for insert to authenticated with check (reporter = auth.uid());
create policy reports_admin  on public.reports for select to authenticated using (public.is_admin());
create policy reports_update on public.reports for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- 집계 뷰 (security_invoker = 보는 사람의 권한으로 실행)
-- =====================================================================
create or replace view public.vote_stats with (security_invoker = on) as
  select opening_id, category_id,
         count(*)::int                         as n,
         avg(public.tier_mid(tier))            as mean,
         coalesce(stddev_samp(public.tier_mid(tier)), 0) as sd
  from public.votes
  group by opening_id, category_id;

create or replace view public.vote_dist with (security_invoker = on) as
  select opening_id, category_id, tier, count(*)::int as n
  from public.votes
  group by opening_id, category_id, tier;

create or replace view public.posts_view with (security_invoker = on) as
  select p.id, p.author, pr.nickname, p.opening_id, o.name as opening_name,
         p.title, p.body, p.created_at, p.edited_at, p.deleted,
         (select count(*) from public.likes l where l.target_type = 'post' and l.target_id = p.id)::int as likes,
         (select count(*) from public.comments c where c.post_id = p.id and not c.deleted)::int as ncomments
  from public.posts p
  join public.profiles pr on pr.id = p.author
  left join public.openings o on o.id = p.opening_id;

create or replace view public.comments_view with (security_invoker = on) as
  select c.id, c.post_id, c.author, pr.nickname, c.body, c.created_at, c.deleted,
         (select count(*) from public.likes l where l.target_type = 'comment' and l.target_id = c.id)::int as likes
  from public.comments c
  join public.profiles pr on pr.id = c.author;

grant select on public.vote_stats, public.vote_dist, public.posts_view, public.comments_view to authenticated;
