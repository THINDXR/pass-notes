-- Live friend requests, cancellable invites, document trash, note history.
-- Additive: no data is removed. Run after the earlier migrations.

-- ───────────── Realtime ─────────────
-- Realtime sends DELETE events without RLS and with only the primary key. Give friendships a
-- random key so those events don't reveal who is friends with whom; the pair stays unique.
alter table friendships add column id uuid not null default gen_random_uuid();
alter table friendships drop constraint friendships_pkey;
alter table friendships add primary key (id); -- friendships_pair still allows one row per pair
alter publication supabase_realtime add table friendships, invites;

-- ───────────── Trash ─────────────
alter table documents add column deleted_at timestamptz;

create function doc_trashed(doc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from documents where id = doc and deleted_at is not null)
$$;

-- While a document is in the trash only its owner has a role on it, so collaborators lose
-- read and write access to it, its notes and its PDF. Restoring brings their access back.
create or replace function doc_role(doc uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.role from document_members m join documents d on d.id = m.document_id
  where m.document_id = doc and m.user_id = auth.uid() and (d.deleted_at is null or m.role = 'owner')
$$;

-- Owner only. Trashing cancels pending invites for the document.
create function set_document_trashed(doc uuid, trashed boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if doc_role(doc) is distinct from 'owner' then raise exception 'not allowed'; end if;
  update documents set deleted_at = case when trashed then now() end where id = doc;
  if trashed then update invites set status = 'cancelled' where document_id = doc and status = 'pending'; end if;
end $$;
revoke execute on function set_document_trashed, doc_trashed from anon, public;
grant execute on function set_document_trashed, doc_trashed to authenticated;

-- permanent delete only from the trash
drop policy documents_delete on documents;
create policy documents_delete on documents for delete to authenticated
  using (doc_role(id) = 'owner' and deleted_at is not null);

-- no new notes, erasing or invites while in the trash (even for the owner)
drop policy strokes_insert on strokes;
create policy strokes_insert on strokes for insert to authenticated
  with check (author_id = auth.uid() and doc_role(document_id) in ('owner', 'editor') and not doc_trashed(document_id));
drop policy strokes_erase on strokes;
create policy strokes_erase on strokes for update to authenticated
  using (doc_role(document_id) in ('owner', 'editor') and not doc_trashed(document_id));
drop policy invites_send on invites;
create policy invites_send on invites for insert to authenticated
  with check (from_id = auth.uid() and status = 'pending' and doc_role(document_id) = 'owner'
    and not doc_trashed(document_id) and are_friends(from_id, to_id));

-- For scripts/cleanup-orphan-pdfs.mjs (secret key only): permanently delete old trash.
create function purge_trashed(min_age interval default '30 days') returns integer
language sql security definer set search_path = public as $$
  with gone as (delete from documents where deleted_at < now() - min_age returning 1)
  select count(*)::int from gone
$$;
revoke execute on function purge_trashed from anon, authenticated, public;
grant execute on function purge_trashed to service_role;

-- ───────────── Invites: cancel ─────────────
alter table invites drop constraint invites_status_check;
alter table invites add constraint invites_status_check
  check (status in ('pending', 'accepted', 'declined', 'cancelled'));
-- the sender may only turn their own pending invite into cancelled
create policy invites_cancel on invites for update to authenticated
  using (from_id = auth.uid() and status = 'pending') with check (status = 'cancelled');
revoke update on invites from authenticated;
grant update (status) on invites to authenticated;

-- same as before, plus: refuse invites whose document is in the trash
create or replace function respond_invite(invite_id uuid, accept boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  inv invites;
  doc uuid;
begin
  select * into inv from invites
    where id = invite_id and to_id = auth.uid() and status = 'pending' for update;
  if not found then raise exception 'invite not found'; end if;

  if not accept then
    update invites set status = 'declined' where id = invite_id;
    return null;
  end if;
  if doc_trashed(inv.document_id) then raise exception 'document is in the trash'; end if;

  if inv.mode = 'collab' then
    insert into document_members values (inv.document_id, auth.uid(), inv.role)
      on conflict (document_id, user_id) do nothing;
    doc := inv.document_id;
  else
    insert into documents (owner_id, title, pdf_path)
      select auth.uid(), title, pdf_path from documents where id = inv.document_id
      returning id into doc;
    insert into strokes (id, document_id, page, author_id, tool, color, width, points)
      select gen_random_uuid(), doc, page, author_id, tool, color, width, points
      from strokes where document_id = inv.document_id and not deleted;
  end if;

  update invites set status = 'accepted' where id = invite_id;
  return doc;
end $$;

-- ───────────── Note history ─────────────
-- Append-only log written by a trigger; users can read it (any role) but never write it.
create table stroke_events (
  id bigint generated always as identity primary key,
  stroke_id uuid not null references strokes on delete cascade,
  document_id uuid not null references documents on delete cascade,
  actor_id uuid references profiles on delete set null,
  action text not null check (action in ('add', 'copy', 'erase', 'restore')),
  at timestamptz not null default now()
);
create index stroke_events_doc on stroke_events (document_id, at desc);
alter table stroke_events enable row level security;
create policy stroke_events_read on stroke_events for select to authenticated using (doc_role(document_id) is not null);
revoke insert, update, delete, truncate on stroke_events from anon, authenticated;

create function log_stroke_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into stroke_events (stroke_id, document_id, actor_id, action)
  values (new.id, new.document_id, auth.uid(),
    case
      when tg_op = 'UPDATE' then case when new.deleted then 'erase' else 'restore' end
      when new.author_id is distinct from auth.uid() then 'copy' -- copied by respond_invite
      else 'add'
    end);
  return null;
end $$;
-- retried writes don't log twice: upsert-ignore skips the insert, and a no-op flag change skips the update
create trigger strokes_log_insert after insert on strokes for each row execute function log_stroke_event();
create trigger strokes_log_update after update of deleted on strokes for each row
  when (old.deleted is distinct from new.deleted) execute function log_stroke_event();

-- existing notes start the history (who erased older notes, and when, was never recorded)
insert into stroke_events (stroke_id, document_id, actor_id, action, at)
  select id, document_id, author_id, 'add', created_at from strokes;
