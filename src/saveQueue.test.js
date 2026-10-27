import test from 'node:test'
import assert from 'node:assert/strict'
import { loadQueue, saveQueue, clearQueue, applyOps, applyRemoteEvent, mergeRemote } from './saveQueue.js'

const memory = () => {
  const m = new Map()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }
}
const U = 'user-1', D = 'doc-1'
const add = (id) => ({ row: { id, document_id: D, page: 1, tool: 'pen', color: '#111111', width: 0.004, points: [[0, 0]] }, at: '2026-01-01T00:00:00Z' })

test('round-trips ops in order and clears when empty', () => {
  const s = memory()
  const ops = [add('a'), { ids: ['a'], deleted: true }, add('b')]
  assert.ok(saveQueue(s, U, D, ops))
  assert.deepEqual(loadQueue(s, U, D), ops)
  clearQueue(s, U, D)
  assert.equal(s.m.size, 0)
  assert.deepEqual(loadQueue(s, U, D), [])
})

test('queues are separate per user and per document', () => {
  const s = memory()
  saveQueue(s, U, D, [add('a')])
  assert.deepEqual(loadQueue(s, 'user-2', D), [])
  assert.deepEqual(loadQueue(s, U, 'doc-2'), [])
  assert.equal(loadQueue(s, U, D).length, 1)
})

test('corrupt or mismatched data is discarded, not thrown', () => {
  const s = memory()
  const key = `passnotes:queue:${U}:${D}`
  s.setItem(key, '{not json')
  assert.deepEqual(loadQueue(s, U, D), [])
  assert.equal(s.m.size, 0)
  s.setItem(key, JSON.stringify({ v: 1, uid: 'someone-else', docId: D, ops: [add('a')] }))
  assert.deepEqual(loadQueue(s, U, D), [])
  assert.equal(s.m.size, 0)
  // bad ops are dropped individually; a row for another document never gets through
  s.setItem(key, JSON.stringify({ v: 1, uid: U, docId: D, ops: [add('a'), { row: { ...add('x').row, document_id: 'doc-2' } }, { ids: 'oops' }, null] }))
  assert.deepEqual(loadQueue(s, U, D), [add('a')])
})

test('storage failures never throw', () => {
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') }, removeItem: () => { throw new Error('denied') } }
  assert.deepEqual(loadQueue(broken, U, D), [])
  assert.equal(saveQueue(broken, U, D, [add('a')]), false)
  assert.equal(saveQueue(null, U, D, [add('a')]), false)
  assert.deepEqual(loadQueue(null, U, D), [])
})

test('applyOps shows queued writes over server state', () => {
  const server = { s1: { id: 's1', deleted: false }, s2: { id: 's2', deleted: false } }
  const out = applyOps(server, [add('a'), { ids: ['s1', 'a'], deleted: true }, { ids: ['missing'], deleted: true }], U)
  assert.equal(out.s1.deleted, true)
  assert.equal(out.s2.deleted, false)
  assert.equal(out.a.deleted, true)
  assert.equal(out.a.author_id, U)
  assert.equal(out.missing, undefined)
  assert.equal(server.s1.deleted, false) // input untouched
})

const row = (id, deleted = false) => ({ id, document_id: D, page: 1, tool: 'pen', color: '#111111', width: 0.004, points: [[0, 0]], deleted })

test('remote add / erase / restore from a collaborator apply immediately', () => {
  let s = {}
  s = applyRemoteEvent(s, { eventType: 'INSERT', new: row('x') }, [])
  assert.equal(s.x.deleted, false)
  s = applyRemoteEvent(s, { eventType: 'UPDATE', new: row('x', true) }, [])
  assert.equal(s.x.deleted, true)
  s = applyRemoteEvent(s, { eventType: 'UPDATE', new: row('x', false) }, [])
  assert.equal(s.x.deleted, false)
  // restore of a note erased before this visit (not loaded): the full row comes with the event
  s = applyRemoteEvent(s, { eventType: 'UPDATE', new: row('old', false) }, [])
  assert.equal(s.old.deleted, false)
})

test('remote events never overwrite a change still in the local queue', () => {
  const local = { a: { ...row('a'), deleted: true } }
  // we erased "a" (queued); a collaborator's older state arrives
  assert.equal(applyRemoteEvent(local, { eventType: 'UPDATE', new: row('a', false) }, [{ ids: ['a'], deleted: true }]).a.deleted, true)
  // once our write is confirmed (queue empty), the server state wins
  assert.equal(applyRemoteEvent(local, { eventType: 'UPDATE', new: row('a', false) }, []).a.deleted, false)
  // a new note drawn here and still queued keeps its local row
  const drawn = applyOps({}, [add('n')], U)
  assert.equal(mergeRemote(drawn, [row('n', true)], [add('n')]).n.deleted, false)
})

test('a late INSERT echo does not resurrect a note erased right after drawing', () => {
  const s = { e: { ...row('e'), deleted: true } }
  assert.equal(applyRemoteEvent(s, { eventType: 'INSERT', new: row('e') }, []), s)
})

test('refetch after reconnecting adds missed notes and missed erases, keeps unchanged state', () => {
  const s = { a: row('a'), b: row('b') }
  const out = mergeRemote(s, [row('a'), row('b', true), row('c')], [])
  assert.equal(out.a, s.a) // untouched object
  assert.equal(out.b.deleted, true)
  assert.equal(out.c.deleted, false)
  assert.equal(mergeRemote(s, [row('a'), row('b')], []), s) // nothing changed → same object
})
