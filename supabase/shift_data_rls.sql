-- This deliberately exposes the single shared schedule to every anonymous visitor.
-- Do not use this policy for personal or confidential data.
begin;

alter table public.shift_data enable row level security;

revoke all on table public.shift_data from anon, authenticated, public;
grant select, insert, update on table public.shift_data to anon;

do $$
declare
    existing_policy record;
begin
    for existing_policy in
        select policyname
        from pg_policies
        where schemaname = 'public'
          and tablename = 'shift_data'
    loop
        execute format('drop policy %I on public.shift_data', existing_policy.policyname);
    end loop;
end
$$;

create policy shift_data_anonymous_read
    on public.shift_data
    for select
    to anon
    using (id = 'main_config');

create policy shift_data_anonymous_insert
    on public.shift_data
    for insert
    to anon
    with check (id = 'main_config');

create policy shift_data_anonymous_update
    on public.shift_data
    for update
    to anon
    using (id = 'main_config')
    with check (id = 'main_config');

commit;
