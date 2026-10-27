-- Personal folders. Each user files documents (their own and shared ones) in their own folders;
-- nobody else sees them, and filing never changes the document or anyone else's filing.

create table folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references profiles on delete cascade,
  name text not null check (name = btrim(name) and length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (id, owner_id) -- target of the composite FK below
);
create unique index folders_owner_name on folders (owner_id, lower(name));
alter table folders enable row level security;
create policy folders_own on folders for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Where a user filed a document. No row = "ไม่จัดหมวด".
-- The FKs are the permission check: the document must be one the user is a member of,
-- and the folder must be the user's own. Deleting a folder, leaving a document or deleting the
-- document only removes the filing row, never a document.
create table document_folders (
  user_id uuid not null default auth.uid(),
  document_id uuid not null,
  folder_id uuid not null,
  primary key (user_id, document_id),
  foreign key (document_id, user_id) references document_members (document_id, user_id) on delete cascade,
  foreign key (folder_id, user_id) references folders (id, owner_id) on delete cascade
);
create index document_folders_folder on document_folders (folder_id, user_id);
alter table document_folders enable row level security;
create policy document_folders_own on document_folders for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- "date added" for sorting: when this user got the document (upload, accepted copy or joined)
alter table document_members add column added_at timestamptz not null default now();
update document_members m set added_at = d.created_at from documents d where d.id = m.document_id;

-- Deleting an account must not delete the notes it wrote in other people's documents and copies.
alter table strokes alter column author_id drop not null;
alter table strokes drop constraint strokes_author_id_fkey;
alter table strokes add constraint strokes_author_id_fkey
  foreign key (author_id) references profiles on delete set null;
