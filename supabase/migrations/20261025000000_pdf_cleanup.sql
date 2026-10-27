-- PDF cleanup. Run after schema.sql (Dashboard → SQL Editor, or `supabase db push`).
-- An uploader may delete their own file only while no document uses it; copies share files,
-- so "in use" must look at every document, not just the ones the caller can see.

create function pdf_in_use(path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from documents where pdf_path = path)
$$;
revoke execute on function pdf_in_use from anon, public;
grant execute on function pdf_in_use to authenticated;

-- Storage needs select permission to delete, so uploaders can also see their own files
drop policy pdfs_read on storage.objects;
create policy pdfs_read on storage.objects for select to authenticated
  using (bucket_id = 'pdfs' and ((storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from documents d where d.pdf_path = storage.objects.name)));

create policy pdfs_delete_unused on storage.objects for delete to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text
    and not pdf_in_use(storage.objects.name));

-- For scripts/cleanup-orphan-pdfs.mjs (secret key only): files no document points at.
-- min_age skips uploads whose document row is still being created.
create function orphan_pdfs(min_age interval default '1 day') returns table (name text)
language sql stable security definer set search_path = public as $$
  select o.name from storage.objects o
  where o.bucket_id = 'pdfs' and o.created_at < now() - min_age
    and not exists (select 1 from documents d where d.pdf_path = o.name)
$$;
revoke execute on function orphan_pdfs from anon, authenticated, public;
grant execute on function orphan_pdfs to service_role;
