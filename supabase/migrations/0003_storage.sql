-- Private bucket for lease documents. Each user can only touch files under a
-- folder named after their user id (path convention: "<uid>/<file>").
insert into storage.buckets (id, name, public)
values ('lease-documents', 'lease-documents', false)
on conflict (id) do nothing;

create policy "own lease files - read"
  on storage.objects for select
  using (bucket_id = 'lease-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own lease files - insert"
  on storage.objects for insert
  with check (bucket_id = 'lease-documents' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own lease files - delete"
  on storage.objects for delete
  using (bucket_id = 'lease-documents' and (storage.foldername(name))[1] = auth.uid()::text);
