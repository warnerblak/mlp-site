create extension if not exists pgcrypto;
create table if not exists public.classifieds(
 id uuid primary key default gen_random_uuid(),
 category text not null check(category in('wanted','for-sale','seeking','help-wanted','public-notice','personals')),
 headline text not null check(char_length(headline) between 4 and 70),
 body text not null check(char_length(body) between 10 and 320),
 handle text,url text,status text not null default 'pending' check(status in('pending','approved','rejected')),
 featured boolean not null default false,created_at timestamptz not null default now(),expires_at timestamptz not null,submitter_hash text not null);
create index if not exists classifieds_public_feed_idx on public.classifieds(status,expires_at desc,featured desc,created_at desc);
create index if not exists classifieds_submitter_rate_idx on public.classifieds(submitter_hash,created_at desc);
alter table public.classifieds enable row level security;
revoke all on table public.classifieds from anon, authenticated;
