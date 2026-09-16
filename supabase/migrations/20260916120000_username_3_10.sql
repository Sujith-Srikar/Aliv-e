-- Tighten the username length rule from 3-30 to 3-10 chars to match the
-- app-level validation in shared/schemas.ts and the dashboard route.

alter table public.users drop constraint if exists users_username_check;
alter table public.users add constraint users_username_check check (username ~ '^[a-zA-Z0-9_-]{3,10}$');
