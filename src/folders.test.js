import test from 'node:test'
import assert from 'node:assert/strict'
import { ALL, UNFILED, folderCounts, folderNameProblem, normalizeFolderName, visibleDocs } from './folders.js'

const folders = [{ id: 'f1', name: 'Math' }, { id: 'f2', name: 'ฟิสิกส์' }]
const docs = [
  { id: 'a', title: 'Lecture 10', role: 'owner', added_at: '2026-01-03', folderId: 'f1' },
  { id: 'b', title: 'Lecture 2', role: 'owner', added_at: '2026-01-01', folderId: null },
  { id: 'c', title: 'กลศาสตร์', role: 'owner', added_at: '2026-01-02', folderId: 'f2' },
  { id: 'd', title: 'Shared notes', role: 'editor', added_at: '2026-01-05', folderId: 'f1' },
  { id: 'e', title: 'Viewer lecture', role: 'viewer', added_at: '2026-01-04', folderId: null },
]
const ids = (list) => list.map((d) => d.id)
const opts = { tab: 'mine', folder: ALL, query: '', sort: 'date' }

test('folder names: required, max length, unique ignoring case and spacing', () => {
  assert.equal(normalizeFolderName('  Math   1 '), 'Math 1')
  assert.match(folderNameProblem('', folders), /ใส่ชื่อ/)
  assert.match(folderNameProblem('x'.repeat(61), folders), /60/)
  assert.equal(folderNameProblem('x'.repeat(60), folders), '')
  assert.match(folderNameProblem('math', folders), /อยู่แล้ว/)
  assert.equal(folderNameProblem('Math', folders, 'f1'), '') // renaming to its own name
  assert.match(folderNameProblem('Math', folders, 'f2'), /อยู่แล้ว/)
})

test('tabs split owned and shared documents', () => {
  assert.deepEqual(ids(visibleDocs(docs, opts)), ['a', 'c', 'b'])
  assert.deepEqual(ids(visibleDocs(docs, { ...opts, tab: 'shared' })), ['d', 'e'])
})

test('filter by folder and unfiled', () => {
  assert.deepEqual(ids(visibleDocs(docs, { ...opts, folder: 'f1' })), ['a'])
  assert.deepEqual(ids(visibleDocs(docs, { ...opts, folder: UNFILED })), ['b'])
  assert.deepEqual(ids(visibleDocs(docs, { ...opts, tab: 'shared', folder: 'f1' })), ['d'])
})

test('search is case-insensitive and combines with folder', () => {
  assert.deepEqual(ids(visibleDocs(docs, { ...opts, query: '  LECTURE ' })), ['a', 'b'])
  assert.deepEqual(ids(visibleDocs(docs, { ...opts, query: 'lecture', folder: UNFILED })), ['b'])
  assert.deepEqual(ids(visibleDocs(docs, { ...opts, query: 'กลศ' })), ['c'])
  assert.deepEqual(visibleDocs(docs, { ...opts, query: 'nothing' }), [])
})

test('sort by name: Thai locale (Thai script first), natural number order', () => {
  assert.deepEqual(ids(visibleDocs(docs, { ...opts, sort: 'name' })), ['c', 'b', 'a'])
})

test('counts per folder within a tab', () => {
  assert.deepEqual(folderCounts(docs, 'mine'), { [ALL]: 3, [UNFILED]: 1, f1: 1, f2: 1 })
  assert.deepEqual(folderCounts(docs, 'shared'), { [ALL]: 2, [UNFILED]: 1, f1: 1 })
})
