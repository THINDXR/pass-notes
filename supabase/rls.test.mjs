// Runs schema.sql on an in-process Postgres with minimal Supabase stubs and checks the access rules.
// Usage: node supabase/rls.test.mjs
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'

const db = new PGlite()
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text, public bool, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (bucket_id text, name text, created_at timestamptz not null default now());
  create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
  create publication supabase_realtime;
  grant usage on schema auth, storage to authenticated;
  grant execute on function auth.uid() to authenticated;
`)
await db.exec(readFileSync(new URL('schema.sql', import.meta.url), 'utf8'))
for (const f of readdirSync(new URL('migrations/', import.meta.url)).sort())
  await db.exec(readFileSync(new URL(`migrations/${f}`, import.meta.url), 'utf8'))
await db.exec(`
  grant usage on schema public to authenticated;
  grant select, insert, delete on all tables in schema public to authenticated;
  grant update on folders, document_folders to authenticated; -- Supabase's default grants; RLS decides
  grant select, insert, delete on storage.objects to authenticated;
  alter table storage.objects enable row level security;
`)

const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c'
await db.exec(`insert into auth.users values ('${A}'), ('${B}'), ('${C}')`)

// run a statement as a signed-in user
async function as(uid, sql, params) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`)
  try { return (await db.query(sql, params)).rows } finally { await db.exec('reset role') }
}
const fails = (p) => assert.rejects(p)

for (const [id, u] of [[A, 'alice'], [B, 'bob'], [C, 'carol']])
  await as(id, `insert into profiles (id, username, display_name) values ($1, $2, $2)`, [id, u])
await fails(as(A, `insert into profiles (id, username, display_name) values ($1, 'fake', 'x')`, [C]))
await fails(as(A, `update profiles set username = 'hacked' where id = $1`, [A]))

// friends: A ↔ B accepted; C is a stranger
await as(A, `insert into friendships (requester_id, addressee_id) values ($1, $2)`, [A, B])
await fails(as(B, `insert into friendships (requester_id, addressee_id) values ($1, $2)`, [B, A])) // duplicate pair
assert.equal((await as(A, `update friendships set status = 'accepted' returning *`)).length, 0) // requester can't self-accept
assert.equal((await as(B, `update friendships set status = 'accepted' returning *`)).length, 1)
assert.equal((await as(C, `select * from friendships`)).length, 0)

// A uploads a document
await fails(as(A, `insert into documents (title, pdf_path) values ('x', '${B}/f.pdf')`))
const [doc] = await as(A, `insert into documents (title, pdf_path) values ('Lecture 1', '${A}/f.pdf') returning id`)
await as(A, `insert into storage.objects values ('pdfs', '${A}/f.pdf')`)
await fails(as(A, `insert into storage.objects values ('pdfs', '${B}/f.pdf')`))
await as(A, `insert into strokes (id, document_id, page, tool, color, width, points) values (gen_random_uuid(), $1, 1, 'pen', '#000000', 0.003, '[[0.1,0.1]]')`, [doc.id])
assert.equal((await as(B, `select * from documents`)).length, 0)
assert.equal((await as(B, `select * from strokes`)).length, 0)
assert.equal((await as(B, `select * from storage.objects`)).length, 0)

// invites: only to friends, only by owner
await fails(as(A, `insert into invites (document_id, title, to_id, mode) values ($1, 't', $2, 'copy')`, [doc.id, C]))
await fails(as(B, `insert into invites (document_id, title, to_id, mode) values ($1, 't', $2, 'copy')`, [doc.id, A]))

// send a copy → B gets an independent document
const [copyInv] = await as(A, `insert into invites (document_id, title, to_id, mode) values ($1, 'Lecture 1', $2, 'copy') returning id`, [doc.id, B])
await fails(as(C, `select respond_invite($1, true)`, [copyInv.id]))
const [{ respond_invite: copyId }] = await as(B, `select respond_invite($1, true)`, [copyInv.id])
assert.notEqual(copyId, doc.id)
await fails(as(B, `select respond_invite($1, true)`, [copyInv.id])) // can't accept twice
assert.equal((await as(B, `select * from strokes where document_id = $1`, [copyId])).length, 1)
assert.equal((await as(B, `select * from storage.objects`)).length, 1) // can read the shared file
await as(B, `update strokes set deleted = true where document_id = $1`, [copyId])
assert.equal((await as(A, `select * from strokes where document_id = $1 and not deleted`, [doc.id])).length, 1) // original untouched
assert.equal((await as(B, `select * from documents where id = $1`, [doc.id])).length, 0) // still can't see original

// collaborate as viewer → can read, can't draw or erase
const [viewInv] = await as(A, `insert into invites (document_id, title, to_id, mode, role) values ($1, 'Lecture 1', $2, 'collab', 'viewer') returning id`, [doc.id, B])
await as(B, `select respond_invite($1, true)`, [viewInv.id])
assert.equal((await as(B, `select * from strokes where document_id = $1`, [doc.id])).length, 1)
await fails(as(B, `insert into strokes (id, document_id, page, tool, color, width, points) values (gen_random_uuid(), $1, 1, 'pen', '#000000', 0.003, '[]')`, [doc.id]))
assert.equal((await as(B, `update strokes set deleted = true where document_id = $1 returning *`, [doc.id])).length, 0)
await fails(as(B, `update strokes set points = '[]' where document_id = $1`, [doc.id]))
await fails(as(B, `insert into invites (document_id, title, to_id, mode) values ($1, 't', $2, 'copy')`, [doc.id, A]))

// B leaves; owner can't be removed
await as(B, `delete from document_members where document_id = $1 and user_id = $2`, [doc.id, B])
assert.equal((await as(B, `select * from documents where id = $1`, [doc.id])).length, 0)
await as(A, `delete from document_members where document_id = $1 and user_id = $2`, [doc.id, A])
assert.equal((await as(A, `select * from documents where id = $1`, [doc.id])).length, 1)

// collaborate as editor → can draw, author must be self
const [editInv] = await as(A, `insert into invites (document_id, title, to_id, mode) values ($1, 'Lecture 1', $2, 'collab') returning id`, [doc.id, B])
await as(B, `select respond_invite($1, true)`, [editInv.id])
await as(B, `insert into strokes (id, document_id, page, tool, color, width, points) values (gen_random_uuid(), $1, 2, 'highlighter', '#ffeb3b', 0.02, '[[0.2,0.2]]')`, [doc.id])
await fails(as(B, `insert into strokes (id, document_id, page, author_id, tool, color, width, points) values (gen_random_uuid(), $1, 2, $2, 'pen', '#000000', 0.003, '[]')`, [doc.id, A]))
assert.equal((await as(B, `delete from documents where id = $1 returning *`, [doc.id])).length, 0) // only owner deletes

// folders: private per user, names validated and unique per user (case-insensitive)
const [fa] = await as(A, `insert into folders (name) values ('Math') returning id`)
await fails(as(A, `insert into folders (name) values ('math')`))
await fails(as(A, `insert into folders (name) values ('')`))
await fails(as(A, `insert into folders (name) values (' Math2')`))
await fails(as(A, `insert into folders (name) values ($1)`, ['x'.repeat(61)]))
await fails(as(A, `insert into folders (owner_id, name) values ($1, 'Spoof')`, [B]))
const [fb] = await as(B, `insert into folders (name) values ('Math') returning id`) // same name, other user: fine
assert.equal((await as(B, `select * from folders`)).length, 1)
assert.equal((await as(B, `update folders set name = 'hacked' where id = $1 returning *`, [fa.id])).length, 0)
assert.equal((await as(B, `delete from folders where id = $1 returning *`, [fa.id])).length, 0)
assert.equal((await as(A, `update folders set name = 'Mathematics' where id = $1 returning *`, [fa.id])).length, 1)

// filing: own folder + own membership only; each person's filing is independent
await as(A, `insert into document_folders (document_id, folder_id) values ($1, $2)`, [doc.id, fa.id])
await as(B, `insert into document_folders (document_id, folder_id) values ($1, $2)`, [doc.id, fb.id])
await fails(as(B, `insert into document_folders (document_id, folder_id) values ($1, $2)`, [copyId, fa.id])) // A's folder
await fails(as(C, `insert into document_folders (document_id, folder_id) values ($1, $2)`, [doc.id, fa.id])) // not a member
await fails(as(B, `insert into document_folders (user_id, document_id, folder_id) values ($1, $2, $3)`, [A, doc.id, fa.id]))
await fails(as(B, `update document_folders set folder_id = $1 where document_id = $2`, [fa.id, doc.id]))
assert.deepEqual((await as(A, `select folder_id from document_folders`)).map((r) => r.folder_id), [fa.id])
assert.equal((await as(C, `select * from document_folders`)).length, 0)
// moving: upsert as the client does; moving to "ไม่จัดหมวด" deletes the row
const [fa2] = await as(A, `insert into folders (name) values ('Physics') returning id`)
await as(A, `insert into document_folders (user_id, document_id, folder_id) values ($1, $2, $3)
  on conflict (user_id, document_id) do update set folder_id = excluded.folder_id`, [A, doc.id, fa2.id])
assert.equal((await as(A, `select folder_id from document_folders`))[0].folder_id, fa2.id)
assert.equal((await as(B, `select folder_id from document_folders`))[0].folder_id, fb.id) // B unaffected
// deleting a folder unfiles its documents; the document survives
await as(A, `delete from folders where id = $1`, [fa2.id])
assert.equal((await as(A, `select * from document_folders`)).length, 0)
assert.equal((await as(A, `select * from documents where id = $1`, [doc.id])).length, 1)
assert.equal((await as(B, `select * from document_folders`)).length, 1)
// leaving a document drops only the leaver's filing
await as(B, `delete from document_members where document_id = $1 and user_id = $2`, [doc.id, B])
assert.equal((await as(B, `select * from document_folders`)).length, 0)
assert.equal((await as(B, `select * from folders`)).length, 1)
assert.ok((await as(A, `select added_at from document_members where document_id = $1`, [doc.id]))[0].added_at)

// invites: only the sender cancels, only while pending
const [inv4] = await as(A, `insert into invites (document_id, title, to_id, mode) values ($1, 'Lecture 1', $2, 'collab') returning id`, [doc.id, B])
assert.equal((await as(B, `update invites set status = 'cancelled' where id = $1 returning *`, [inv4.id])).length, 0)
await fails(as(A, `update invites set status = 'accepted' where id = $1`, [inv4.id]))
await fails(as(A, `update invites set to_id = $2 where id = $1`, [inv4.id, C]))
assert.equal((await as(A, `update invites set status = 'cancelled' where id = $1 returning *`, [inv4.id])).length, 1)
await fails(as(B, `select respond_invite($1, true)`, [inv4.id])) // a cancelled invite can't be accepted
assert.equal((await as(A, `update invites set status = 'cancelled' where id = $1 returning *`, [editInv.id])).length, 0) // already accepted
assert.equal((await as(C, `select * from invites`)).length, 0)

// trash: owner only; collaborators lose access while trashed; restore brings it back
const [inv5] = await as(A, `insert into invites (document_id, title, to_id, mode) values ($1, 'Lecture 1', $2, 'collab') returning id`, [doc.id, B])
await as(B, `select respond_invite($1, true)`, [inv5.id])
const [pending] = await as(A, `insert into invites (document_id, title, to_id, mode) values ($1, 'Lecture 1', $2, 'copy') returning id`, [doc.id, B])
await fails(as(B, `select set_document_trashed($1, true)`, [doc.id]))
await fails(as(C, `select set_document_trashed($1, true)`, [doc.id]))
assert.equal((await as(A, `delete from documents where id = $1 returning *`, [doc.id])).length, 0) // must be trashed first
await as(A, `select set_document_trashed($1, true)`, [doc.id])
assert.ok((await as(A, `select deleted_at from documents where id = $1`, [doc.id]))[0].deleted_at)
assert.equal((await as(B, `select * from documents where id = $1`, [doc.id])).length, 0)
assert.equal((await as(B, `select * from strokes where document_id = $1`, [doc.id])).length, 0)
const newStroke = (who, docId) => as(who, `insert into strokes (id, document_id, page, tool, color, width, points) values (gen_random_uuid(), $1, 1, 'pen', '#000000', 0.003, '[[0.5,0.5]]')`, [docId])
await fails(newStroke(B, doc.id))
await fails(newStroke(A, doc.id)) // no writing in the trash, even for the owner
assert.equal((await as(A, `update strokes set deleted = true where document_id = $1 returning *`, [doc.id])).length, 0)
await fails(as(A, `insert into invites (document_id, title, to_id, mode) values ($1, 't', $2, 'copy')`, [doc.id, B]))
assert.equal((await as(A, `select status from invites where id = $1`, [pending.id]))[0].status, 'cancelled')
await fails(as(B, `select respond_invite($1, true)`, [pending.id]))
await fails(as(B, `select set_document_trashed($1, false)`, [doc.id]))
assert.equal((await as(B, `delete from documents where id = $1 returning *`, [doc.id])).length, 0)
assert.equal((await as(B, `select * from documents where id = $1`, [copyId])).length, 1) // B's copy unaffected
assert.equal((await as(B, `select * from storage.objects where name = '${A}/f.pdf'`)).length, 1) // via the copy
assert.equal((await as(A, `delete from storage.objects where name = '${A}/f.pdf' returning *`)).length, 0) // trashed doc still uses it
await as(A, `select set_document_trashed($1, false)`, [doc.id])
assert.equal((await as(B, `select * from documents where id = $1`, [doc.id])).length, 1) // access is back

// history: written by the database, readable by every member, never writable by users
const sid = crypto.randomUUID()
const insertSid = `insert into strokes (id, document_id, page, tool, color, width, points) values ($1, $2, 1, 'pen', '#000000', 0.003, '[[0.3,0.3]]')`
await as(B, insertSid, [sid, doc.id])
await as(B, insertSid + ' on conflict do nothing', [sid, doc.id]) // offline-queue retry
await as(A, `update strokes set deleted = true where id = $1`, [sid])
await as(A, `update strokes set deleted = true where id = $1`, [sid]) // retry: no state change
await as(B, `update strokes set deleted = false where id = $1`, [sid])
const history = () => as(A, `select actor_id, action from stroke_events where stroke_id = $1 order by id`, [sid])
const expected = [{ actor_id: B, action: 'add' }, { actor_id: A, action: 'erase' }, { actor_id: B, action: 'restore' }]
assert.deepEqual(await history(), expected)
await fails(as(A, `insert into stroke_events (stroke_id, document_id, actor_id, action) values ($1, $2, $3, 'add')`, [sid, doc.id, A]))
await as(A, `update stroke_events set actor_id = null`).catch(() => {})
await as(A, `delete from stroke_events`).catch(() => {})
assert.deepEqual(await history(), expected) // untouched
assert.equal((await as(C, `select * from stroke_events`)).length, 0)
assert.ok((await as(B, `select action from stroke_events where document_id = $1`, [copyId])).some((e) => e.action === 'copy'))
await db.query(`update document_members set role = 'viewer' where document_id = $1 and user_id = $2`, [doc.id, B])
assert.ok((await as(B, `select * from stroke_events where document_id = $1`, [doc.id])).length > 0) // viewers can read
assert.equal((await as(B, `update strokes set deleted = true where id = $1 returning *`, [sid])).length, 0) // but not erase
await db.query(`update document_members set role = 'editor' where document_id = $1 and user_id = $2`, [doc.id, B])

// friendships have a random key (realtime DELETE events carry only the key); pairs stay unique
await as(C, `insert into friendships (requester_id, addressee_id) values ($1, $2)`, [C, A])
await fails(as(A, `insert into friendships (requester_id, addressee_id) values ($1, $2)`, [A, C]))
assert.ok((await as(C, `select id from friendships`))[0].id)
await as(A, `delete from friendships where requester_id = $1 and addressee_id = $2`, [C, A])

// PDF cleanup: uploaders delete only their own unused files; shared files survive
await as(A, `insert into storage.objects values ('pdfs', '${A}/orphan.pdf')`)
assert.equal((await as(B, `delete from storage.objects where name = '${A}/orphan.pdf' returning *`)).length, 0)
assert.equal((await as(A, `delete from storage.objects where name = '${A}/orphan.pdf' returning *`)).length, 1)
await as(A, `select set_document_trashed($1, true)`, [doc.id])
await as(A, `delete from documents where id = $1`, [doc.id]) // B's copy still uses A's file
assert.equal((await as(A, `delete from storage.objects where name = '${A}/f.pdf' returning *`)).length, 0)
assert.equal((await as(B, `delete from storage.objects where name = '${A}/f.pdf' returning *`)).length, 0)
await fails(as(A, `select * from orphan_pdfs('0')`)) // cleanup listing is server-only
assert.equal((await db.query(`select * from orphan_pdfs('0')`)).rows.length, 0)
await as(B, `select set_document_trashed($1, true)`, [copyId])
assert.equal((await db.query(`select * from orphan_pdfs('0')`)).rows.length, 0) // still referenced from the trash
await as(B, `delete from documents where id = $1`, [copyId])
assert.deepEqual((await db.query(`select * from orphan_pdfs('0')`)).rows, [{ name: `${A}/f.pdf` }])
assert.equal((await db.query(`select * from orphan_pdfs('1 day')`)).rows.length, 0) // fresh uploads are skipped

// deleting an account keeps the notes it wrote in other people's copies
const [doc2] = await as(A, `insert into documents (title, pdf_path) values ('Lecture 2', '${A}/g.pdf') returning id`)
await as(A, `insert into strokes (id, document_id, page, tool, color, width, points) values (gen_random_uuid(), $1, 1, 'pen', '#000000', 0.003, '[[0.1,0.1]]')`, [doc2.id])
await as(A, `insert into folders (name) values ('Temp')`)
const [inv3] = await as(A, `insert into invites (document_id, title, to_id, mode) values ($1, 'Lecture 2', $2, 'copy') returning id`, [doc2.id, B])
const [{ respond_invite: copy2 }] = await as(B, `select respond_invite($1, true)`, [inv3.id])
await db.query(`delete from auth.users where id = $1`, [A])
const kept = await as(B, `select author_id from strokes where document_id = $1`, [copy2])
assert.deepEqual(kept, [{ author_id: null }])
assert.equal((await db.query(`select * from folders where owner_id = $1`, [A])).rows.length, 0)
assert.equal((await db.query(`select * from documents where id = $1`, [doc2.id])).rows.length, 0) // owned docs go with the account

console.log('rls ok')
